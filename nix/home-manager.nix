packages:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.obelisk;
  system = pkgs.stdenv.hostPlatform.system;
  available = packages.${system} or { };
in
{
  options.programs.obelisk = {
    enable = lib.mkEnableOption "Obelisk";

    cli.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to install the Obelisk command-line client.";
    };

    skill.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Whether to link the retrieval skill into ~/.agents/skills/obelisk.";
    };

    app.enable = lib.mkOption {
      type = lib.types.bool;
      default = available ? app;
      defaultText = lib.literalMD "true on systems with an Obelisk desktop package";
      description = "Whether to install the Obelisk desktop app.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !(cfg.cli.enable || cfg.skill.enable) || packages ? ${system};
        message = "Obelisk CLI and skill packages are unavailable on ${system}.";
      }
      {
        assertion = !cfg.app.enable || available ? app;
        message = "programs.obelisk.app.enable is set, but Obelisk has no desktop package for ${system}.";
      }
    ];

    home.packages =
      lib.optional (cfg.cli.enable && available ? cli) available.cli
      ++ lib.optional (cfg.app.enable && available ? app) available.app;

    home.file = lib.mkIf (cfg.skill.enable && available ? skill) {
      ".agents/skills/obelisk".source = "${available.skill}/share/skills/obelisk/obelisk";
    };
  };
}
