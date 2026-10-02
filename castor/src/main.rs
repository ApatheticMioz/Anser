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
pub mod skills;
mod state;
mod task;
pub mod telemetry;
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
    Proxy {
        /// Override the state dir root
        #[arg(long)]
        state_dir: Option<String>,
        /// Override the listen port
        #[arg(long)]
        port: Option<u16>,
        /// Override the upstream engine port
        #[arg(long)]
        engine_port: Option<u16>,
    },
    /// Run the status / long-poll HTTP server (singleton)
    Status {
        /// Override the state dir root
        #[arg(long)]
        state_dir: Option<String>,
        /// Override the listen port
        #[arg(long)]
        port: Option<u16>,
    },
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
    /// (test helper) hold a task slot for a few seconds
    #[command(name = "__sem_child", hide = true)]
    __SemChild {
        /// State dir root
        state_dir: String,
        /// Task id to bind to the lease
        task_id: String,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Mcp) {
        Command::Mcp => {
            let loaded = config::load().map_err(|e| format!("config: {e}"))?;
            // Best-effort, non-blocking bring-up of the status server
            // (lock → probe → spawn if down → release). Never blocks serve.
            let state = state::StateDir::from_config(&loaded.config);
            let _ = state.ensure();
            task::wait::ensure_status_server(&state, loaded.config.ports.status).await;
            // Best-effort, non-blocking bring-up of the stream proxy.
            proxy::ensure_proxy_server(
                &state,
                loaded.config.ports.proxy,
                loaded.config.ports.engine,
            )
            .await;
            mcp::serve(&loaded.config.tool_prefix).await?;
        }
        Command::Proxy {
            state_dir,
            port,
            engine_port,
        } => {
            let loaded = config::load().map_err(|e| format!("config: {e}"))?;
            let state = match state_dir {
                Some(dir) => state::StateDir::new(dir),
                None => state::StateDir::from_config(&loaded.config),
            };
            let _ = state.ensure();
            let port = port.unwrap_or(loaded.config.ports.proxy);
            let engine_port = engine_port.unwrap_or(loaded.config.ports.engine);
            let upstream = std::net::SocketAddr::from(([127, 0, 0, 1], engine_port));
            let server = proxy::ProxyServer::new(&state, upstream);
            if !server.try_acquire_lock() {
                // Another live process holds the singleton lock: exit 0 with a
                // single stderr line (never fight a live keeper).
                eprintln!("proxy already running");
                return Ok(());
            }
            server.serve(port).await?;
        }
        Command::Status { state_dir, port } => {
            let loaded = config::load().map_err(|e| format!("config: {e}"))?;
            let state = match state_dir {
                Some(dir) => state::StateDir::new(dir),
                None => state::StateDir::from_config(&loaded.config),
            };
            let _ = state.ensure();
            let port = port.unwrap_or(loaded.config.ports.status);
            let server = task::wait::StatusServer::new(&state);
            if !server.try_acquire_lock() {
                // Another live process holds the singleton lock: exit 0 with a
                // single stderr line (never fight a live keeper).
                eprintln!("status server already running");
                return Ok(());
            }
            server.serve(port).await?;
        }
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
        Command::__SemChild { state_dir, task_id } => {
            let state = state::StateDir::new(state_dir);
            let _ = state.ensure();
            let sem = task::semaphore::TaskSemaphore::new(&state, 1);
            let lease = sem.acquire(&task_id).await;
            println!("HELD");
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let _ = sem.release(&lease);
        }
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
