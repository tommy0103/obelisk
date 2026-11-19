{
  lib,
  buildNpmPackage,
  copyDesktopItems,
  darwin,
  electron_43-bin,
  importNpmLock,
  makeDesktopItem,
  makeWrapper,
  nodejs_22,
  stdenv,
}:

let
  electron = electron_43-bin;
  inherit (stdenv.hostPlatform) isDarwin;
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
  # The locked better-sqlite3 and @parcel/watcher packages ship platform-specific Node-API bindings.
  npmRebuildFlags = [ "--ignore-scripts" ];
  env.ELECTRON_SKIP_BINARY_DOWNLOAD = "1";

  nativeBuildInputs = [
    makeWrapper
  ]
  ++ (if isDarwin then [ darwin.autoSignDarwinBinariesHook ] else [ copyDesktopItems ]);

  preBuild =
    "cd app\n"
    + lib.optionalString isDarwin ''
      # Nix owns updates. Omit the release-only Sparkle rebuild and framework copy.
      npm pkg delete build.beforePack build.mac.extraFiles
    '';
  npmBuildScript = "pack";
  npmBuildFlags = [
    "--"
    # On macOS, electron-builder must rewrite the extracted helper bundles' plists.
    "-c.electronDist=${if isDarwin then electron.src else electron.dist}"
    "-c.electronVersion=${electron.version}"
    "-c.npmRebuild=false"
  ]
  ++ lib.optional isDarwin "-c.mac.identity=null";

  installPhase = ''
    runHook preInstall
    install -Dm644 ../LICENSE "$out/share/licenses/obelisk-app/LICENSE"
  ''
  + (
    if isDarwin then
      ''
        mkdir -p "$out/Applications"
        mv release/mac*/Obelisk.app "$out/Applications/"
        echo nix > "$out/Applications/Obelisk.app/Contents/Resources/package-type"
        makeWrapper "$out/Applications/Obelisk.app/Contents/MacOS/Obelisk" "$out/bin/obelisk-app"
      ''
    else
      ''
        mkdir -p "$out/share/obelisk-app"
        cp -r release/*-unpacked/resources/app.asar{,.unpacked} "$out/share/obelisk-app/"
        install -Dm644 build/icon.svg "$out/share/icons/hicolor/scalable/apps/obelisk-app.svg"
        makeWrapper ${lib.getExe electron} "$out/bin/obelisk-app" \
          --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ stdenv.cc.cc.lib ]} \
          --add-flags "$out/share/obelisk-app/app.asar"
      ''
  )
  + ''
    runHook postInstall
  '';

  desktopItems = lib.optionals (!isDarwin) [
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
    platforms = [
      "x86_64-linux"
      "aarch64-darwin"
      "x86_64-darwin"
    ];
  };
}
