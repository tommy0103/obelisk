let
  obelisk = builtins.getFlake (toString ../.);
  # Home Manager release-26.05 is a test dependency.
  homeManager = builtins.getFlake "github:nix-community/home-manager/5643e73425b85ac359ba2aaf83deae8ce1cd7968";
  system = builtins.currentSystem;
  pkgs = obelisk.inputs.nixpkgs.legacyPackages.${system};
  packages = obelisk.packages.${system};
  hasApp = packages ? app;
  skillPath = ".agents/skills/obelisk";

  homeFor =
    settings:
    (homeManager.lib.homeManagerConfiguration {
      inherit pkgs;
      modules = [
        obelisk.homeManagerModules.default
        {
          home.username = "tester";
          home.homeDirectory = if pkgs.stdenv.hostPlatform.isDarwin then "/Users/tester" else "/home/tester";
          home.stateVersion = "26.05";
          programs.obelisk = settings;
        }
      ];
    }).config.home;

  check =
    settings:
    {
      cli ? false,
      skill ? false,
      app ? false,
    }:
    let
      home = homeFor settings;
      installed = package: builtins.elem package home.packages;
      source = home.file.${skillPath}.source or null;
    in
    installed packages.cli == cli
    && (hasApp && installed packages.app) == app
    && source == (if skill then "${packages.skill}/share/skills/obelisk/obelisk" else null);

  disabledComponents = {
    cli.enable = false;
    skill.enable = false;
    app.enable = false;
  };
  enabled.enable = true;
  only = component: enabled // disabledComponents // { ${component}.enable = true; };
in
assert check { } { };
assert check { app.enable = true; } { };
assert check enabled {
  cli = true;
  skill = true;
  app = hasApp;
};
assert check (enabled // disabledComponents) { };
assert check (only "cli") { cli = true; };
assert check (only "skill") { skill = true; };
assert
  if hasApp then
    check (only "app") { app = true; }
  else
    !(builtins.tryEval (homeFor (only "app"))).success;
true
