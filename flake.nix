{
  description = "Obelisk desktop app, CLI, and retrieval skill";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
    in
    {
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
        // nixpkgs.lib.optionalAttrs (system == "x86_64-linux") {
          app = pkgs.callPackage ./nix/app.nix { };
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
                nativeBuildInputs = [
                  pkgs.sqlite
                  pkgs.xvfb-run
                ];
              }
              ''
                skill=${packages.cli}/share/skills/obelisk/obelisk
                cmp ${./skill-doc/SKILL.md} "$skill/SKILL.md"
                diff -r ${./skill-doc/references} "$skill/references"
                xvfb-run -a bash ${./nix/check-desktop.sh} \
                  ${packages.app}/bin/obelisk-app ${packages.cli}/bin/obelisk ${./tests/fixtures/claude/custom-title-session.jsonl}
                touch "$out"
              '';
        }
      );
    };
}
