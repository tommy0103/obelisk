// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import * as ObeliskPlugin from '../packages/dsh-plugin/src/index.ts'

const { inject } = ObeliskPlugin

const repoRoot = resolve(import.meta.dirname, '..')
const pluginRoot = join(repoRoot, 'packages', 'dsh-plugin')
const pluginSkillRoot = join(pluginRoot, 'skill')
const pluginSkill = readFileSync(join(pluginSkillRoot, 'SKILL.md'), 'utf8')

// @deepseek-ai/dsh-skill-filesystem 0.0.1-rc.1 assigns these ranks. They are
// kept explicit because the public registry exports only its bundled rank;
// lower ranks win and runtime registrations occupy rank 250.
const DSH_FILESYSTEM_RANKS = {
  projectDsh: 100,
  projectAgents: 200,
  userDsh: 400,
  userAgents: 500,
}

function bodyOf(raw) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(raw)
  assert.ok(match, 'skill must have frontmatter')
  return raw.slice(match[0].length).trim()
}

function boot(plugin = ObeliskPlugin) {
  let definition = null
  const ctx = {
    skills: {
      register(skill) {
        definition = skill
        return () => { definition = null }
      },
    },
  }
  plugin.apply(ctx)
  assert.ok(definition)
  return definition
}

test('depends only on the standard DSH skill registry', () => {
  assert.deepEqual(inject, ['skills'])
  boot()
})

test('registers the plugin-owned Obelisk skill as a runtime contribution', () => {
  const loaded = boot()
  assert.equal(loaded.name, 'obelisk')
  assert.equal(loaded.provider, '@obelisk/dsh-obelisk-plugin')
  assert.equal(loaded.source, 'runtime')
  assert.deepEqual(loaded.invocation, { modelInvocable: true, userInvocable: true })
  assert.match(loaded.description, /Search and query past Claude Code, Codex, Kimi Code, and Pi session history/)
  assert.equal(loaded.content, bodyOf(pluginSkill))
  assert.equal(loaded.resourceBase.kind, 'directory')
  assert.equal(resolve(loaded.resourceBase.path), pluginSkillRoot)
})

test('exposes every resource referenced by the plugin-owned skill', () => {
  const loaded = boot()
  const references = [...loaded.content.matchAll(/`(references\/[^`]+\.md)`/g)].map(match => match[1])
  assert.ok(references.length > 0)
  for (const relative of new Set(references)) {
    assert.equal(existsSync(join(loaded.resourceBase.path, relative)), true, relative)
  }
})

test('loads the built package from dist/skill', async () => {
  const distIndex = join(pluginRoot, 'dist', 'index.js')
  const distSkillRoot = join(pluginRoot, 'dist', 'skill')
  assert.equal(existsSync(distIndex), true, 'build the DSH plugin before running its tests')

  const distPlugin = await import(pathToFileURL(distIndex).href)
  const loaded = boot(distPlugin)
  assert.equal(resolve(loaded.resourceBase.path), distSkillRoot)
  assert.equal(loaded.content, bodyOf(pluginSkill))
  const references = [...loaded.content.matchAll(/`(references\/[^`]+\.md)`/g)].map(match => match[1])
  for (const relative of new Set(references)) {
    assert.equal(existsSync(join(loaded.resourceBase.path, relative)), true, relative)
  }
})

test('fails clearly when a packaged skill tree is missing', async () => {
  const fixtureRoot = mkdtempSync(join(pluginRoot, '.missing-skill-'))
  const fixtureDist = join(fixtureRoot, 'dist')
  mkdirSync(fixtureDist)
  copyFileSync(join(pluginRoot, 'dist', 'index.js'), join(fixtureDist, 'index.js'))
  try {
    const missingPlugin = await import(`${pathToFileURL(join(fixtureDist, 'index.js')).href}?missing-skill`)
    assert.throws(
      () => boot(missingPlugin),
      /Obelisk DSH plugin skill bundle is missing; expected SKILL\.md at/,
    )
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('loads and unloads through the real DSH skill registry', async () => {
  const packageRequire = createRequire(new URL('../packages/dsh-plugin/package.json', import.meta.url))
  const { Context } = await import(pathToFileURL(packageRequire.resolve('@deepseek-ai/cordis')).href)
  const { default: SkillRegistry } = await import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-skill')).href)
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  const fiber = await ctx.plugin(ObeliskPlugin)

  assert.deepEqual((await ctx.skills.list()).map(skill => skill.name), ['obelisk'])
  assert.equal((await ctx.skills.get('obelisk'))?.content, bodyOf(pluginSkill))

  await fiber.dispose()
  assert.deepEqual(await ctx.skills.list(), [])
})

test('shadows a user-global Obelisk skill while preserving project override precedence', async () => {
  const packageRequire = createRequire(new URL('../packages/dsh-plugin/package.json', import.meta.url))
  const { Context } = await import(pathToFileURL(packageRequire.resolve('@deepseek-ai/cordis')).href)
  const { default: SkillRegistry } = await import(pathToFileURL(packageRequire.resolve('@deepseek-ai/dsh-skill')).href)

  async function winnerFor(rank, source) {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    ctx.skills.registerProvider(() => ({
      name: `competing-${source}`,
      list: () => Promise.resolve([{
        name: 'obelisk',
        description: `Competing ${source} skill`,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: `competing-${source}`,
        source,
        rank,
        locator: source,
      }]),
      get: candidate => Promise.resolve({
        name: candidate.name,
        description: candidate.description,
        invocation: candidate.invocation,
        provider: candidate.provider,
        source: candidate.source,
        content: `Content from ${source}`,
      }),
    }))
    await ctx.plugin(ObeliskPlugin)
    return ctx.skills.get('obelisk')
  }

  assert.equal((await winnerFor(DSH_FILESYSTEM_RANKS.userDsh, 'user-dsh'))?.provider, '@obelisk/dsh-obelisk-plugin')
  assert.equal((await winnerFor(DSH_FILESYSTEM_RANKS.userAgents, 'user-agents'))?.provider, '@obelisk/dsh-obelisk-plugin')
  assert.equal((await winnerFor(DSH_FILESYSTEM_RANKS.projectDsh, 'project-dsh'))?.provider, 'competing-project-dsh')
  assert.equal((await winnerFor(DSH_FILESYSTEM_RANKS.projectAgents, 'project-agents'))?.provider, 'competing-project-agents')
})

test('declares an installable local DSH bundle', () => {
  const manifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh, { bundle: { patch: './obelisk.cordis.yml' } })
  assert.ok(manifest.files.includes('obelisk.cordis.yml'))

  const patch = readFileSync(join(pluginRoot, 'obelisk.cordis.yml'), 'utf8')
  assert.match(patch, /id: obelisk/)
  assert.match(patch, /name: '@obelisk\/dsh-obelisk-plugin'/)
})
