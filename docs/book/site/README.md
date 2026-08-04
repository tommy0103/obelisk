# Obelisk Book — 交互版

`docs/book/*.md` 的读本。**那 17 个 markdown 是唯一的正文源，这个站点只读它们，从不修改。**

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # → dist/，相对 base，可以直接静态托管
npm run preview
```

## 它是怎么拼起来的

```
docs/book/*.md
      │  plugins/book-markdown.mjs   构建期解析成 block 树
      ▼
  virtual:book  ──→  src/book/index.js  ──合并──  src/book/manifest.js
                            │                    （covers · hook · 自测题）
                            ▼
                     src/chapters/<slug>.vue     每章一个，持有自己的交互件
                            │
                            ▼
                  src/components/ChapterBody.vue
                     正文 ── 交互件 ── 章末 recap 卡片
```

正文渲染只有 `src/blocks/` 那几个组件；`src/interactives/` 是教学装置，和 markdown 无关。

## 交互件挂在哪儿：引用一个真实标题

章节组件里这样声明：

```js
const SLUG = '04-the-pivot';

const ANCHORS = [
  { afterHeading: '两条正交轴', widget: OrthogonalAxes, title: 'N + M，还是 N × M' },
];
```

`afterHeading` 引用的是 markdown 里的一个 h2/h3 原文。默认插在**那一节的末尾**（读者先读完论证，再动手）；传 `position: 'start'` 则紧跟标题。

书是可以随时重编的，所以引用会过期。`plugins/anchor-check.mjs` 在 `buildStart` 扫描所有 `src/chapters/*.vue`，任何一个 `afterHeading` 对不上就**让 `npm run build` 失败**——不会静默把交互件丢在地上。`npm run dev` 下同样会在控制台报错。

它也会挡住引用 recap 段落里的标题：`这一章你应该带走的` 那一节被单独提出来渲染成卡片，挂在里面的交互件不会出现。

## 加一个交互件

1. 写 `src/interactives/Foo.vue`。数据放 `src/book/` 下（`quizzes.js` / `flows.js` / `fixtures.js` 已经是数据驱动的，多半不用新建组件）。
2. 在对应章节的 `ANCHORS` 里加一条，`afterHeading` 抄一个真实标题。
3. `npm run build` 会告诉你抄错没有。

## 几个约定

- **模块地图只有一份**：`src/book/modules.js` 定义节点与两套边（数据流 / 依赖方向），`SystemMap.vue` 同时是封面插图、`/map` 页、章节配图和侧栏缩略图。
- **每章声明 `covers`**（`manifest.js`）：侧栏缩略图据此点亮。读到最后一章，整张图刚好被点亮过一遍。
- **术语卡每章只标一次**：`src/book/glossary.js` + `InlineSpans.js` 的 glossary pass，且不在术语自己的主场章节里标注。
- **路由用 hash history**：产物要能从任意静态路径（甚至 `file://`）打开，不依赖服务端 rewrite。
- 这个目录有自己的 toolchain，仓库根的 eslint 不管它（和 `app/` 同理）。
