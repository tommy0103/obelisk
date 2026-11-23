# Obelisk with Home Manager

With Obelisk available as a flake input named `obelisk`, add this module to
your Home Manager configuration. The example assumes the configuration receives
`inputs` through `extraSpecialArgs`.

在 flake 中添加名为 `obelisk` 的输入，并通过 `extraSpecialArgs` 将 `inputs`
传给 Home Manager 后，可以在用户配置中启用 Obelisk。

```nix
{ inputs, ... }:
{
  imports = [ inputs.obelisk.homeManagerModules.default ];
  programs.obelisk.enable = true;
}
```

| Option under `programs.obelisk` | Default | Effect / 作用 |
| --- | --- | --- |
| `cli.enable` | `true` | Install the `obelisk` command / 安装命令行工具 |
| `skill.enable` | `true` | Link the skill at `~/.agents/skills/obelisk` / 将 skill 链接到此目录 |
| `app.enable` | `true` where packaged / 有桌面包时启用 | Install the desktop app / 安装桌面端 |

Set any component to `false` to skip it. With all three off, the module installs
nothing. Explicitly enabling the desktop app on an unsupported platform fails
when Home Manager evaluates the configuration.

可单独关闭任意组件。三个组件全部关闭时，模块不会安装软件或创建链接。
在没有桌面包的平台显式启用 `app` 时，Home Manager 会在配置求值时报错。
