{
  description = "Obelisk desktop app, CLI, and retrieval skill";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      # Desktop targets shipped by .github/workflows/release-app.yml.
      desktopSystems = [
        "x86_64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];
      systems = desktopSystems ++ [ "aarch64-linux" ];
    in
    {
      homeManagerModules.default = import ./nix/home-manager.nix self.packages;

      packages = nixpkgs.lib.genAttrs systems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          skill = pkgs.callPackage ./nix/skill.nix { };
          cli = pkgs.callPackage ./nix/cli.nix { inherit skill; };
        in
        {
          inherit cli skill;
          default = cli;
        }
        // nixpkgs.lib.optionalAttrs (builtins.elem system desktopSystems) {
          app = pkgs.callPackage ./nix/app.nix { inherit desktopSystems; };
        }
      );

      checks = nixpkgs.lib.genAttrs systems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          packages = self.packages.${system};
        in
        {
          inherit (packages) cli;
        }
        // nixpkgs.lib.optionalAttrs (packages ? app) {
          packaging =
            pkgs.runCommand "obelisk-packaging-check"
              {
                nativeBuildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [
                  pkgs.nodejs_22
                  pkgs.sqlite
                  pkgs.xvfb-run
                ];
              }
              ''
                ${
                  if pkgs.stdenv.hostPlatform.isDarwin then
                    ''
                      test -x ${packages.app}/Applications/Obelisk.app/Contents/MacOS/Obelisk
                    ''
                  else
                    ''
                      export FONTCONFIG_FILE=${pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; }}
                      xvfb-run -a bash ${./nix/check-desktop.sh} \
                        ${packages.app}/bin/obelisk-app ${packages.cli}/bin/obelisk ${./tests/fixtures/claude/custom-title-session.jsonl} \
                        ${nixpkgs.lib.getExe packages.app.electron}
                    ''
                }
                touch "$out"
              '';
        }
      );
    };
}
