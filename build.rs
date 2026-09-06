use std::{env, process::Command};

fn main() {
    println!("cargo:rerun-if-changed=static");
    println!("cargo:rerun-if-changed=tsconfig.json");
    println!("cargo:rerun-if-changed=package.json");
    println!("cargo:rerun-if-changed=bunfig.toml");
    let output = env::var_os("OUT_DIR").expect("Cargo must provide OUT_DIR");
    let status = Command::new("bun")
        .args([
            "build",
            "static/app.ts",
            "static/theme.ts",
            "--target=browser",
            "--format=iife",
            "--minify",
            "--outdir",
        ])
        .arg(output)
        .status()
        .expect("Install Bun and make it available in PATH to build the frontend");
    assert!(status.success(), "Bun could not build the frontend");
}
