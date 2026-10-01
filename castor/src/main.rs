//! Castor: Rust MCP toolchain, proxy, and evo engine.
//!
//! Subcommands: mcp (default), proxy, status, server, config, install, clean, evo.

mod config;
mod evo;
mod engine;
mod mcp;
mod platform;
mod proxy;
mod runner;
mod skills;
mod state;
mod task;
mod telemetry;
mod tools;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "castor", version, about = "Castor: Rust MCP toolchain, proxy, and evo engine")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Run the MCP server (default subcommand)
    Mcp,
    /// Run the stream proxy
    Proxy,
    /// Show status
    Status,
    /// Run the HTTP server
    Server,
    /// Manage configuration
    Config,
    /// Install / register
    Install,
    /// Clean state
    Clean,
    /// Evo engine
    Evo,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Mcp) {
        Command::Mcp => unimplemented!("castor mcp"),
        Command::Proxy => unimplemented!("castor proxy"),
        Command::Status => unimplemented!("castor status"),
        Command::Server => unimplemented!("castor server"),
        Command::Config => {
            if let Err(e) = config::print_effective() {
                eprintln!("castor: {e}");
                std::process::exit(1);
            }
        }
        Command::Install => unimplemented!("castor install"),
        Command::Clean => unimplemented!("castor clean"),
        Command::Evo => unimplemented!("castor evo"),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_subcommand_is_mcp() {
        let cli = Cli::parse_from(["castor"]);
        assert!(matches!(cli.command, None));
    }

    #[test]
    fn all_subcommands_parse() {
        for name in [
            "mcp",
            "proxy",
            "status",
            "server",
            "config",
            "install",
            "clean",
            "evo",
        ] {
            let cli = Cli::parse_from(["castor", name]);
            assert!(cli.command.is_some(), "subcommand {name} should parse");
        }
    }
}
