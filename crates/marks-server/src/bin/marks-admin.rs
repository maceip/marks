use marks_server::backup;
use std::path::PathBuf;

fn usage() -> ! {
    eprintln!(
        "Usage:\n  marks-admin verify <backup-directory>\n  marks-admin restore <backup-directory> <database-path> <asset-directory>\n\nRestore refuses to overwrite either destination; stop marks-server first."
    );
    std::process::exit(2);
}

#[tokio::main]
async fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let result = match args.as_slice() {
        [command, path] if command == "verify" => {
            backup::verify(PathBuf::from(path)).await.map(|manifest| {
                println!(
                    "verified {} assets; database sha256 {}",
                    manifest.assets.len(),
                    manifest.database_sha256
                );
            })
        }
        [command, source, database, assets] if command == "restore" => backup::restore(
            PathBuf::from(source),
            PathBuf::from(database),
            PathBuf::from(assets),
        )
        .await
        .map(|()| println!("restore verified and published")),
        _ => usage(),
    };
    if let Err(error) = result {
        eprintln!("marks-admin: {error}");
        std::process::exit(1);
    }
}
