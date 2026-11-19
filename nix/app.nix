{
  lib,
  buildNpmPackage,
  copyDesktopItems,
  darwin,
  desktopSystems,
  electron_43-bin,
  importNpmLock,
  jq,
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
# Use the pinned Nixpkgs runtime, allowing newer minor and patch releases
# within Obelisk's locked Electron major.
assert lib.assertMsg (
  lib.versions.major electron.version == lib.versions.major lockedElectron
  && lib.versionAtLeast electron.version lockedElectron
) "Update the Nix Electron package to satisfy the locked Electron version within the same major";
buildNpmPackage {
  pname = "obelisk-app";
  version = (lib.importJSON ../app/package.json).version;
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../LICENSE
      ../app
      ../package.json
      ../packages/adaptive-watcher
      ../packages/core
      ../tsconfig.json
    ];
  };

  nodejs = nodejs_22;
  npmRoot = "app";
  npmDeps = importNpmLock { npmRoot = ../app; };
  npmConfigHook = importNpmLock.npmConfigHook;
  # The locked better-sqlite3 and @parcel/watcher packages ship platform-specific Node-API bindings.
  npmRebuildFlags = [ "--ignore-scripts" ];
  env.OBELISK_DISABLE_UPDATER = "1";
  disallowedReferences = [ nodejs_22 ];

  nativeBuildInputs = [
    makeWrapper
  ]
  ++ (if isDarwin then [ darwin.autoSignDarwinBinariesHook ] else [ copyDesktopItems ]);

  preBuild = ''
    cd app
    # Only Electron runs at runtime. Exclude build and CLI tools whose patched
    # shebangs would otherwise retain the build host's Node inside app.asar.
    ${jq}/bin/jq '
      .build.files += [
        "!**/node_modules/node-gyp/**",
        "!**/node_modules/node-addon-api/tools/**",
        "!**/node_modules/{electron-sparkle-updater,js-yaml,nopt,semver,which}/bin/**"
      ]
      | del(.build.beforePack | select(. == "scripts/sparkle-packaging.mjs"))
      | del(.build.mac.extraFiles[]? | select(.from? == "node_modules/electron-sparkle-updater/native/vendor/Sparkle.framework"))
    ' package.json > nix-package.json
    mv nix-package.json package.json
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

  passthru = { inherit electron; };
  meta = {
    description = "Desktop app for browsing and indexing local coding-agent history";
    homepage = "https://github.com/tommy0103/obelisk";
    license = lib.licenses.agpl3Only;
    mainProgram = "obelisk-app";
    platforms = desktopSystems;
  };
}
