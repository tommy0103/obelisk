{
  lib,
  stdenvNoCC,
  nodejs_22,
}:

stdenvNoCC.mkDerivation {
  pname = "obelisk-skill";
  version = (lib.importJSON ../packaging/skill-package.json).version;
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../packaging
      ../skill-doc
    ];
  };

  nativeBuildInputs = [ nodejs_22 ];
  buildPhase = ''
    runHook preBuild
    node packaging/build-skill.mjs
    runHook postBuild
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/share/skills/obelisk"
    cp -r dist/obelisk-skill "$out/share/skills/obelisk/obelisk"
    install -Dm644 packaging/skill-LICENSE "$out/share/licenses/obelisk-skill/LICENSE"
    runHook postInstall
  '';

  meta = {
    description = "Obelisk retrieval skill and reference documentation for coding agents";
    homepage = "https://github.com/tommy0103/obelisk";
    license = lib.licenses.mit;
    platforms = lib.platforms.all;
  };
}
