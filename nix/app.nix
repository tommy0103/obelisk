{
  lib,
  buildNpmPackage,
  copyDesktopItems,
  electron_43-bin,
  importNpmLock,
  makeDesktopItem,
  makeWrapper,
  nodejs_22,
  stdenv,
}:

let
  electron = electron_43-bin;
  lockedElectron = (lib.importJSON ../app/package-lock.json).packages."node_modules/electron".version;
in
assert lib.assertMsg (
  lib.versions.major electron.version == lib.versions.major lockedElectron
) "Update the Nix Electron package to match the major version in app/package-lock.json";
buildNpmPackage {
  pname = "obelisk-app";
  version = (lib.importJSON ../app/package.json).version;
  src = ../.;

  nodejs = nodejs_22;
  npmRoot = "app";
  npmDeps = importNpmLock { npmRoot = ../app; };
  npmConfigHook = importNpmLock.npmConfigHook;
  # The locked better-sqlite3 and @parcel/watcher packages ship Linux Node-API bindings.
  npmRebuildFlags = [ "--ignore-scripts" ];
  env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

  nativeBuildInputs = [
    copyDesktopItems
    makeWrapper
  ];

  preBuild = "cd app";
  npmBuildScript = "pack";
  npmBuildFlags = [
    "--"
    "-c.electronDist=${electron.dist}"
    "-c.electronVersion=${electron.version}"
    "-c.npmRebuild=false"
  ];

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/share/obelisk-app"
    cp -r release/*-unpacked/resources/app.asar{,.unpacked} "$out/share/obelisk-app/"
    install -Dm644 ../LICENSE "$out/share/licenses/obelisk-app/LICENSE"
    install -Dm644 build/icon.svg "$out/share/icons/hicolor/scalable/apps/obelisk-app.svg"
    makeWrapper ${lib.getExe electron} "$out/bin/obelisk-app" \
      --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ stdenv.cc.cc.lib ]} \
      --add-flags "$out/share/obelisk-app/app.asar"
    runHook postInstall
  '';

  desktopItems = [
    (makeDesktopItem {
      name = "obelisk";
      desktopName = "Obelisk";
      exec = "obelisk-app";
      icon = "obelisk-app";
      categories = [ "Development" ];
    })
  ];

  meta = {
    description = "Desktop app for browsing and indexing local coding-agent history";
    homepage = "https://github.com/tommy0103/obelisk";
    license = lib.licenses.agpl3Only;
    mainProgram = "obelisk-app";
    platforms = [ "x86_64-linux" ];
  };
}
