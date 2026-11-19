{
  description = "Kompass — dev shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, rust-overlay }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system:
        f (import nixpkgs { inherit system; overlays = [ rust-overlay.overlays.default ]; }));
    in
    {
      devShells = forAllSystems (pkgs:
        let
          # Rust stable with the wasm32 target, exactly as engine/rust-toolchain.toml says (CI reads it too).
          rust = pkgs.rust-bin.fromRustupToolchainFile ./engine/rust-toolchain.toml;
          # Libraries the PyPI wheels (pyarrow, shapely, pyosmium, rasterio, ...) expect from an FHS
          # distro. Exported on LD_LIBRARY_PATH so `uv run` works on NixOS without nix-ld.
          pythonLibs = with pkgs; [ stdenv.cc.cc.lib zlib ];
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              bun
              nodejs_24
              rust
              # must match the `wasm-bindgen` crate version in engine/Cargo.toml (`=0.2.127`)
              wasm-bindgen-cli_0_2_127
              binaryen
              uv
              python313
              tippecanoe
              pmtiles
              osmium-tool
              gdal
              chromium
            ];

            shellHook = ''
              # uv uses the nix Python: its own downloads need an FHS loader NixOS doesn't have
              export UV_PYTHON="${pkgs.python313}/bin/python3"
              export UV_PYTHON_DOWNLOADS=never
              # Playwright's downloaded browsers don't run on NixOS: the e2e uses this one
              export KOMPASS_E2E_CHROMIUM="${pkgs.chromium}/bin/chromium"
            '' + pkgs.lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
              export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath pythonLibs}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
            '';
          };
        });

      formatter = forAllSystems (pkgs: pkgs.nixpkgs-fmt);
    };
}
