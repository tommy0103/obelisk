{
  lib,
  buildNpmPackage,
  importNpmLock,
  makeWrapper,
  nodejs_22,
  skill,
}:

buildNpmPackage {
  pname = "obelisk-cli";
  version = (lib.importJSON ../packages/cli/package.json).version;
  src = ../.;

  nodejs = nodejs_22;
  npmDeps = importNpmLock { npmRoot = ../.; };
  npmConfigHook = importNpmLock.npmConfigHook;
  # Only sibling workspaces use native modules; the CLI uses Node's built-in SQLite.
  npmRebuildFlags = [ "--ignore-scripts" ];
  npmBuildScript = "build:cli";
  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib/obelisk" "$out/bin" "$out/share/skills/obelisk"
    cp -r packages/cli/{dist,package.json,README.md} LICENSE "$out/lib/obelisk/"
    makeWrapper ${nodejs_22}/bin/node "$out/bin/obelisk" \
      --add-flags "$out/lib/obelisk/dist/cli/src/obelisk.js" \
      --prefix PATH : ${lib.makeBinPath [ nodejs_22 ]}
    ln -s ${skill}/share/skills/obelisk/obelisk "$out/share/skills/obelisk/obelisk"
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    export HOME="$TMPDIR/cli-home"
    mkdir -p "$HOME"
    test "$("$out/bin/obelisk" --version)" = "$version"
    echo "return sql('SELECT COUNT(*) AS count FROM sessions')[0].count" > "$TMPDIR/query.mjs"
    test "$("$out/bin/obelisk" --query "$TMPDIR/query.mjs")" = 0
    runHook postInstallCheck
  '';

  meta = {
    description = "Local Obelisk retrieval CLI for coding agents";
    homepage = "https://github.com/tommy0103/obelisk";
    license = lib.licenses.agpl3Only;
    mainProgram = "obelisk";
  };
}
