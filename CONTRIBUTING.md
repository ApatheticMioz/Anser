# Contributing to LLM_Ecosystem

Thank you for your interest in contributing to **LLM_Ecosystem** and the **Anser** agent harness!

---

## Architectural Principles & Invariants

Before submitting code, please review our core architectural invariants:

1. **Dual Platform Agnosticism (Windows 11 & WSL2 Ubuntu)**:
   - All server logic, path handling, and tests must operate identically on native Windows and WSL2.
   - Use `wsl_bridge.js` for path translations between Windows drive paths (`D:\...`) and POSIX mount paths (`/mnt/d/...`).
   - Never assume `/` or `\` as the universal path separator without normalization.
2. **Zero-Risk Containment Guarantee**:
   - The harness enforces a 5-layer sandboxed filesystem boundary. Code modifications, AST replacements, or shell executions must **never** escape the workspace root.
   - Any new filesystem or shell capability must be accompanied by boundary security test cases in `mcp-qwen/tests/security.test.js`.
3. **Pure Text Coworker Execution**:
   - The local Qwen model runs with `--language-model-only` to preserve 100% of GPU VRAM for the 245K context and speculative decoding. Never route vision/image tasks to the local model.
4. **In-Process Tool Execution**:
   - New tools should be implemented as in-process Anser microkernel plugins (`src/harness/services/`) rather than external CLI subprocesses to maintain sub-millisecond execution speeds.

---

## Development Workflow

### 1. Setting Up the Environment

```powershell
# Clone the repository
git clone https://github.com/ApatheticMioz/LLM_Ecosystem.git
cd LLM_Ecosystem\mcp-qwen

# Install dependencies
npm install
```

### 2. Running Test Suites

Run the full automated test suite before opening a pull request:

```powershell
# Run standard test suite (Security, Canary, Evo, Semaphore)
npm test

# Run all tests including streaming proxies
npm run test:all
```

To run individual test suites:
```powershell
npm run test:security    # 90-vector blast-radius sandboxing audit
npm run test:canary      # AST search/replace, syntax gate, trace condenser
npm run test:evo         # Closed-loop evaluation & snapshot rollback
npm run test:semaphore   # Cross-process lease exclusion tests
npm run test:proxy       # Universal UTF-8 streaming proxy verification
```

Verify tests inside WSL2 as well:
```bash
wsl -e bash -c "cd /mnt/d/LLM_Ecosystem/mcp-qwen && npm test"
```

---

## Commit Guidelines

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` A new feature or capability.
- `fix:` A bug fix.
- `refactor:` Code restructuring without behavioral changes.
- `test:` Adding or updating test suites.
- `docs:` Documentation updates and audit logs.
- `perf:` Performance optimizations (e.g. latency, VRAM savings).

---

## Reporting Vulnerabilities

If you discover a sandbox escape or security vulnerability, please do not open a public issue. Report details privately to the project maintainers.
