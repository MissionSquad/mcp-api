# Python MCP Servers Implementation Guide (mcp-api)

## Scope
This guide defines the exact, verified changes required to add first-class support for installing, managing, and running Python MCP servers in `mcp-api`. The implementation must preserve existing Node.js package behavior and Streamable HTTP transport behavior.

## Verified Inputs
1. Package service: `mcp-api/src/services/packages.ts`.
2. Packages controller: `mcp-api/src/controllers/packages.ts`.
3. MCP service (server registration and stdio transport): `mcp-api/src/services/mcp.ts`.
4. Package API schema: `mcp-api/openapi-packages.json`.
5. MCP API schema: `mcp-api/openapi-mcp.json`.
6. Environment config: `mcp-api/src/env.ts`.
7. Example environment: `mcp-api/example.env`.
8. README patterns: `mcp-api/README.md`.

## Current Behavior (Verified)
1. Package installation uses npm in `PackageService.installPackage`, creates a package directory under `packages/`, runs `npm init -y`, installs the npm package, then registers the server as stdio or streamable HTTP depending on `transportType`.
2. Stdio server registration uses `MCPService.addServer` with `command`, `args`, and `env`. The server is run via `StdioClientTransport`.
3. Package upgrades use `npm install` and update server command/args only for stdio servers.
4. `InstallPackageRequest` only supports npm-oriented fields (`name`, `version`, `command`, `args`, `env`, `transportType`, optional streamable HTTP fields).
5. Package metadata does not include a runtime discriminator or Python-specific fields.

## Objectives
1. Support Python MCP servers that run over stdio by installing them into a per-server virtual environment.
2. Preserve existing Node.js behavior and Streamable HTTP behavior without regressions.
3. Provide a safe, deterministic install/upgrade/uninstall flow that does not rely on guessing Python entry points.

## Non-Goals
1. Building or packaging Python MCP servers (only install, manage, and run).
2. Running Python MCP servers via Streamable HTTP when they are remote-only; use existing `streamable_http` support for that.

## Required Design Decisions (Definitive)
1. A runtime discriminator is mandatory: `runtime: "node" | "python"`.
2. For Python servers, entrypoint is mandatory and explicit. Use `pythonModule` and run `python -m <pythonModule>`.
3. Python installs are isolated per server using a virtual environment under the `packages/` directory.
4. Python installs and upgrades must use `pip` from that virtual environment, never the system pip.
5. `transportType` for Python installs must be `stdio`. Streamable HTTP Python servers are managed via the existing `mcp` server API, not via Python package installation.

## Data Model Changes (Required)
Update the following TypeScript types and stored documents in `mcp-api/src/services/packages.ts`.

### Exact Type Additions (Insert These)

1) Add a runtime discriminator type near the top of the file (directly above `export interface PackageInfo`):

```ts
export type PackageRuntime = 'node' | 'python'
```

2) Update `PackageInfo` to include runtime and Python metadata. Insert these fields inside the existing interface:

```ts
  runtime?: PackageRuntime
  pythonModule?: string
  pythonArgs?: string[]
  venvPath?: string
  pipIndexUrl?: string
  pipExtraIndexUrl?: string
```

3) Update `InstallPackageRequest` to include runtime and Python fields. Insert these fields inside the existing interface:

```ts
  runtime?: PackageRuntime
  pythonModule?: string
  pythonArgs?: string[]
  pipIndexUrl?: string
  pipExtraIndexUrl?: string
```

### Validation Rules (Must Implement)
1. When `runtime === "python"`, `pythonModule` is required and `transportType` must be `stdio`.
2. When `runtime === "node"`, the existing npm behavior remains unchanged.
3. Python package `name` is PyPI-only (no extras, no VCS URLs). Do not loosen validation.

## API Schema Updates (Required)
Update `openapi-packages.json`:
1. Add `runtime`, `pythonModule`, `pythonArgs`, `pipIndexUrl`, `pipExtraIndexUrl` to `InstallPackageRequest`.
2. Add `runtime`, `pythonModule`, `pythonArgs`, `venvPath`, `pipIndexUrl`, `pipExtraIndexUrl` to `PackageInfo`.
3. Add examples for a Python install request.

Update `README.md`:
1. Add a Python install example under `POST /packages/install`.
2. Document that Python installs require `pythonModule`.
3. Document the venv location and how upgrades work.

## Environment Configuration (Required)
Add optional environment overrides in `mcp-api/src/env.ts` and `mcp-api/example.env`:
1. `PYTHON_BIN` (optional): absolute path to the Python executable to create venvs. Default: `python3`, then `python`.
2. `PYTHON_VENV_DIR` (optional): base directory under project root for Python venvs. Default: `packages/python`.
3. `PIP_INDEX_URL` (optional): default pip index URL for Python installs.
4. `PIP_EXTRA_INDEX_URL` (optional): default extra index URL.

## Implementation Details (Exact Insertions)

This section specifies the exact functions, types, and insertion points required. All new functions listed below do **not** exist today and must be added exactly as shown.

### File: `mcp-api/src/env.ts`
**Insert these fields into the exported `env` object** (after `SEARXNG_URL` to keep the existing ordering consistent):

```ts
  PYTHON_BIN: process.env.PYTHON_BIN,
  PYTHON_VENV_DIR: process.env.PYTHON_VENV_DIR || 'packages/python',
  PIP_INDEX_URL: process.env.PIP_INDEX_URL,
  PIP_EXTRA_INDEX_URL: process.env.PIP_EXTRA_INDEX_URL
```

### File: `mcp-api/example.env`
**Append these optional variables**:

```
PYTHON_BIN=/usr/bin/python3
PYTHON_VENV_DIR=packages/python
PIP_INDEX_URL=
PIP_EXTRA_INDEX_URL=
```

### File: `mcp-api/src/services/packages.ts`

#### 1) Imports (add these at the top)
**Exact insert** next to the existing `child_process` and `util` imports:

```ts
import { execFile as execFileCallback } from 'child_process'
```

And add a new promisified helper:

```ts
const execFile = promisify(execFileCallback)
```

#### 2) New Types (insert above `export interface PackageInfo`)

```ts
export type PackageRuntime = 'node' | 'python'
```

#### 3) Extend `PackageInfo` (insert inside the interface)

```ts
  runtime?: PackageRuntime
  pythonModule?: string
  pythonArgs?: string[]
  venvPath?: string
  pipIndexUrl?: string
  pipExtraIndexUrl?: string
```

#### 4) Extend `InstallPackageRequest` (insert inside the interface)

```ts
  runtime?: PackageRuntime
  pythonModule?: string
  pythonArgs?: string[]
  pipIndexUrl?: string
  pipExtraIndexUrl?: string
```

#### 5) Add Python Helper Methods (insert inside `PackageService` class)
**Insert these methods directly after the constructor** to keep helper code near the top of the class:

```ts
  private sanitizeServerName(serverName: string): string {
    return serverName.replace(/[^a-zA-Z0-9_-]/g, '-')
  }

  private async resolvePythonExecutable(): Promise<string> {
    const candidates = [env.PYTHON_BIN, 'python3', 'python'].filter(Boolean) as string[]
    for (const candidate of candidates) {
      try {
        await execFile(candidate, ['-V'])
        return candidate
      } catch {
        // Try next candidate
      }
    }
    throw new Error('Python executable not found. Set PYTHON_BIN or install python3.')
  }

  private resolveVenvPaths(serverName: string): { absolute: string; relative: string } {
    const sanitized = this.sanitizeServerName(serverName)
    const relative = path.join(env.PYTHON_VENV_DIR || 'packages/python', sanitized)
    const absolute = path.resolve(process.cwd(), relative)
    return { absolute, relative }
  }

  private venvBinDir(): string {
    return process.platform === 'win32' ? 'Scripts' : 'bin'
  }

  private venvPythonPath(venvAbsolutePath: string): string {
    const binDir = this.venvBinDir()
    const exeName = process.platform === 'win32' ? 'python.exe' : 'python'
    return path.join(venvAbsolutePath, binDir, exeName)
  }

  private venvPipPath(venvAbsolutePath: string): string {
    const binDir = this.venvBinDir()
    const exeName = process.platform === 'win32' ? 'pip.exe' : 'pip'
    return path.join(venvAbsolutePath, binDir, exeName)
  }

  private async ensureVenv(pythonExecutable: string, venvAbsolutePath: string): Promise<void> {
    const pythonPath = this.venvPythonPath(venvAbsolutePath)
    if (existsSync(pythonPath)) {
      return
    }
    await mkdir(venvAbsolutePath, { recursive: true })
    await execFile(pythonExecutable, ['-m', 'venv', venvAbsolutePath])
  }

  private async pipInstall(
    venvAbsolutePath: string,
    spec: string,
    options: { indexUrl?: string; extraIndexUrl?: string },
    extraArgs: string[] = []
  ): Promise<void> {
    const pipPath = this.venvPipPath(venvAbsolutePath)
    const args = ['install', ...extraArgs, spec]
    if (options.indexUrl) {
      args.push('--index-url', options.indexUrl)
    }
    if (options.extraIndexUrl) {
      args.push('--extra-index-url', options.extraIndexUrl)
    }
    await execFile(pipPath, args)
  }

  private async pipShowVersion(venvAbsolutePath: string, name: string): Promise<string> {
    const pipPath = this.venvPipPath(venvAbsolutePath)
    const { stdout } = await execFile(pipPath, ['show', name])
    const versionLine = stdout.split('\n').find(line => line.startsWith('Version:'))
    if (!versionLine) {
      throw new Error(`Unable to determine installed version for ${name}`)
    }
    return versionLine.replace('Version:', '').trim()
  }

  private async pipIndexLatestVersion(
    venvAbsolutePath: string,
    name: string,
    options: { indexUrl?: string; extraIndexUrl?: string }
  ): Promise<string | undefined> {
    try {
      const pipPath = this.venvPipPath(venvAbsolutePath)
      const args = ['index', 'versions', name]
      if (options.indexUrl) {
        args.push('--index-url', options.indexUrl)
      }
      if (options.extraIndexUrl) {
        args.push('--extra-index-url', options.extraIndexUrl)
      }
      const { stdout } = await execFile(pipPath, args)
      const line = stdout.split('\n').find(entry => entry.startsWith('Available versions:'))
      if (!line) {
        return undefined
      }
      const versions = line.replace('Available versions:', '').split(',').map(v => v.trim())
      return versions[0]
    } catch {
      // Older pip may not support `index versions`
      return undefined
    }
  }

  private buildPythonArgs(pythonModule: string, pythonArgs?: string[]): string[] {
    return ['-u', '-m', pythonModule, ...(pythonArgs ?? [])]
  }

  private buildPythonEnv(venvAbsolutePath: string, customEnv?: Record<string, string>): Record<string, string> {
    const venvBin = path.join(venvAbsolutePath, this.venvBinDir())
    const existingPath = customEnv?.PATH ?? process.env.PATH ?? ''
    return {
      ...customEnv,
      PYTHONUNBUFFERED: '1',
      VIRTUAL_ENV: venvAbsolutePath,
      PATH: `${venvBin}${path.delimiter}${existingPath}`
    }
  }
```

#### 6) `installMissingPackage` (add a Python guard at the top)
**Insert this block at the start of `installMissingPackage` before existing stdio logic**:

```ts
      const existingPackage = await this.getPackageById(serverName)
      if (existingPackage?.runtime === 'python') {
        log({ level: 'warn', msg: `Server ${serverName} is Python; automatic reinstall is not supported.` })
        return false
      }
```

#### 7) `installPackage` (rename request env variable and add a Python branch)
**First rename the destructured request env to avoid conflicts with `env` from `../env`:**

Replace the existing destructure:

```ts
    const {
      name,
      version,
      serverName,
      transportType,
      command,
      args,
      env,
      url,
      headers,
      sessionId,
      reconnectionOptions,
      secretName,
      enabled = true,
      failOnWarning = false
    } = request
```

With:

```ts
    const {
      name,
      version,
      serverName,
      transportType,
      command,
      args,
      env: envVars,
      url,
      headers,
      sessionId,
      reconnectionOptions,
      secretName,
      enabled = true,
      failOnWarning = false
    } = request
```

Then update references in the stdio branch to use `envVars` instead of `env`.

**Also persist `runtime: "node"` for Node installs** by setting `packageInfo.runtime = 'node'` when the npm install branch succeeds. This keeps metadata consistent across installs/upgrades.

Insert this immediately before the existing `await this.packagesDBClient.update(packageInfo, { name })` in the npm branch:

```ts
      packageInfo.runtime = 'node'
```

**Now insert this Python branch immediately after the request destructuring and `resolvedTransportType` definition**, before the npm package name validation:

```ts
    const runtime: PackageRuntime = request.runtime ?? 'node'

    if (runtime === 'python') {
      if (!request.pythonModule) {
        return { success: false, error: 'pythonModule is required for python runtime.' }
      }
      if (!/^[a-zA-Z0-9_.]+$/.test(request.pythonModule)) {
        return { success: false, error: `Invalid pythonModule: ${request.pythonModule}` }
      }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
        return { success: false, error: `Invalid Python package name: ${name}` }
      }
      if (resolvedTransportType !== 'stdio') {
        return { success: false, error: 'Python runtime only supports stdio transport.' }
      }
      if (url || headers || sessionId || reconnectionOptions) {
        return { success: false, error: 'Streamable HTTP fields are not allowed for python runtime.' }
      }

      const { absolute: venvAbsolutePath, relative: venvRelativePath } = this.resolveVenvPaths(serverName)
      const pythonPackageInfo: PackageInfo = {
        name,
        version: version || 'latest',
        installPath: venvRelativePath,
        venvPath: venvRelativePath,
        status: 'installing',
        installed: new Date(),
        mcpServerId: serverName,
        enabled,
        runtime: 'python',
        pythonModule: request.pythonModule,
        pythonArgs: request.pythonArgs,
        pipIndexUrl: request.pipIndexUrl ?? env.PIP_INDEX_URL,
        pipExtraIndexUrl: request.pipExtraIndexUrl ?? env.PIP_EXTRA_INDEX_URL
      }

      await this.packagesDBClient.upsert(pythonPackageInfo, { name })

      try {
        const pythonExecutable = await this.resolvePythonExecutable()
        await this.ensureVenv(pythonExecutable, venvAbsolutePath)

        const spec = version ? `${name}==${version}` : name
        await this.pipInstall(venvAbsolutePath, spec, {
          indexUrl: pythonPackageInfo.pipIndexUrl,
          extraIndexUrl: pythonPackageInfo.pipExtraIndexUrl
        })

        const installedVersion = await this.pipShowVersion(venvAbsolutePath, name)
        const pythonCommand = this.venvPythonPath(venvAbsolutePath)
        const pythonArgs = this.buildPythonArgs(request.pythonModule, request.pythonArgs)
        const pythonEnv = this.buildPythonEnv(venvAbsolutePath, envVars)

        const server = await this.mcpService.addServer({
          name: serverName,
          transportType: 'stdio',
          command: pythonCommand,
          args: pythonArgs,
          env: pythonEnv,
          secretName,
          enabled
        })

        pythonPackageInfo.version = installedVersion
        pythonPackageInfo.status = 'installed'
        await this.packagesDBClient.update(pythonPackageInfo, { name })

        return { success: true, package: pythonPackageInfo, server }
      } catch (error) {
        pythonPackageInfo.status = 'error'
        pythonPackageInfo.error = (error as Error).message
        await this.packagesDBClient.update(pythonPackageInfo, { name })
        return { success: false, error: (error as Error).message }
      }
    }
```

**Note:** This branch bypasses `npm init -y` and npm installs entirely.

#### 8) `upgradePackage` (add Python branch)
**Insert this branch inside the existing `try { ... }` block, immediately after the server is disabled (after `const wasEnabled = server.enabled` and the optional `disableServer` call):**

```ts
        const runtime: PackageRuntime = packageInfo.runtime ?? 'node'
        if (runtime === 'python') {
          const venvAbsolutePath = packageInfo.venvPath
            ? path.resolve(process.cwd(), packageInfo.venvPath)
            : path.resolve(process.cwd(), packageInfo.installPath)

          const spec = version ? `${packageInfo.name}==${version}` : packageInfo.name
          await this.pipInstall(
            venvAbsolutePath,
            spec,
            { indexUrl: env.PIP_INDEX_URL, extraIndexUrl: env.PIP_EXTRA_INDEX_URL },
            ['--upgrade']
          )

          const newVersion = await this.pipShowVersion(venvAbsolutePath, packageInfo.name)
          packageInfo.version = newVersion
          packageInfo.status = 'installed'
          packageInfo.lastUpgraded = new Date()
          packageInfo.updateAvailable = false

          if (wasEnabled) {
            const enabledServer = await this.mcpService.enableServer(serverName)
            if (!enabledServer) {
              throw new Error(`Failed to re-enable server ${serverName} after upgrade`)
            }
          }

          await this.packagesDBClient.update(packageInfo, { mcpServerId: serverName })
          return { success: true, package: packageInfo, server }
        }
```

**Important:** This relies on the `pipInstall` helper defined above that supports `extraArgs`.

#### 9) `checkForUpdates` (add Python branch)
**Insert inside the loop, before npm update logic**:

```ts
          if (pkg.runtime === 'python') {
            const venvAbsolutePath = pkg.venvPath
              ? path.resolve(process.cwd(), pkg.venvPath)
              : path.resolve(process.cwd(), pkg.installPath)
            const latest = await this.pipIndexLatestVersion(venvAbsolutePath, pkg.name, {
              indexUrl: pkg.pipIndexUrl ?? env.PIP_INDEX_URL,
              extraIndexUrl: pkg.pipExtraIndexUrl ?? env.PIP_EXTRA_INDEX_URL
            })
            const latestVersion = latest ?? 'unknown'
            const updateAvailable = latest ? latest !== pkg.version : false
            pkg.latestVersion = latestVersion
            pkg.updateAvailable = updateAvailable
            await this.packagesDBClient.update(pkg, { mcpServerId: pkg.mcpServerId })
            updates.push({
              serverName: pkg.mcpServerId,
              currentVersion: pkg.version,
              latestVersion,
              updateAvailable
            })
            continue
          }
```

If `pip index versions` is unsupported (older pip), `pipIndexLatestVersion` returns `undefined`. The logic above then yields `latestVersion: "unknown"` and `updateAvailable: false` deterministically.

#### 10) `uninstallPackage` (use venvPath when present)
**Replace the existing installPath deletion block** with this exact logic:

```ts
      const installPath = packageInfo.venvPath ?? packageInfo.installPath
      if (installPath) {
        const absoluteInstallPath = path.resolve(process.cwd(), installPath)
        if (existsSync(absoluteInstallPath)) {
          await rm(absoluteInstallPath, { recursive: true, force: true })
        }
      }
```

### File: `mcp-api/openapi-packages.json`

#### 1) `InstallPackageRequest` schema
**Add these properties under `InstallPackageRequest.properties`**:

```json
"runtime": {
  "type": "string",
  "enum": ["node", "python"],
  "description": "Package runtime. Defaults to node if omitted."
},
"pythonModule": {
  "type": "string",
  "description": "Python module to execute with -m (required for python runtime)."
},
"pythonArgs": {
  "type": "array",
  "items": { "type": "string" },
  "description": "Arguments appended after -m <pythonModule>."
},
"pipIndexUrl": {
  "type": "string",
  "description": "Optional pip index URL for this install."
},
"pipExtraIndexUrl": {
  "type": "string",
  "description": "Optional extra pip index URL for this install."
}
```

#### 2) `PackageInfo` schema
**Add these properties under `PackageInfo.properties`**:

```json
"runtime": {
  "type": "string",
  "enum": ["node", "python"],
  "description": "Package runtime."
},
"pythonModule": {
  "type": "string",
  "description": "Python module executed with -m."
},
"pythonArgs": {
  "type": "array",
  "items": { "type": "string" },
  "description": "Arguments passed to the Python module."
},
"venvPath": {
  "type": "string",
  "description": "Relative path to the Python virtual environment."
},
"pipIndexUrl": {
  "type": "string",
  "description": "pip index URL used for installs/upgrades."
},
"pipExtraIndexUrl": {
  "type": "string",
  "description": "pip extra index URL used for installs/upgrades."
}
```

### File: `mcp-api/README.md`
Add a Python install example under `POST /packages/install`:

```json
{
  "name": "my-python-mcp",
  "serverName": "python-mcp",
  "runtime": "python",
  "pythonModule": "my_mcp_server",
  "pythonArgs": ["--port", "0"],
  "enabled": true
}
```

Add text:
1. Python installs always use a venv under `packages/python/<serverName>`.
2. Python upgrades use `pip install --upgrade` within that venv.
3. For Python runtime, `installPath` and `venvPath` are the same directory (the venv). No npm package directory is created.
4. If `pipIndexUrl` or `pipExtraIndexUrl` are provided at install time, they are persisted and reused for upgrades.

## How It Works (Concrete Flow)
1. `POST /packages/install` with `runtime: "python"` enters the Python branch in `PackageService.installPackage`.
2. A venv is created (if missing) using `python -m venv`.
3. `pip install` runs inside the venv and the exact package version is read with `pip show`.
4. The MCP server is registered as stdio with `command` pointing to the venv Python executable and `args` using `-u -m <pythonModule>`.
5. The Package record stores runtime, module name, args, venv path, and pip index URLs for idempotent upgrades.

## Idempotency and Backwards Compatibility Guarantees
1. Re-installing the same Python package with the same `serverName` reuses the same venv path and safely re-runs `pip install`.
2. Node installs continue to use npm and must explicitly set `runtime: "node"` in `PackageInfo` after success.
3. Existing Node/stdio and streamable HTTP behavior remains unchanged; Python runtime is opt-in.

## Validation Guarantees
1. Python installs cannot use Streamable HTTP transport.
2. Python entrypoint is explicit (`pythonModule`) and validated.
3. Pip is invoked via `execFile` (argument array), not shell strings.
4. Python package names must be simple PyPI names (no extras or VCS URLs).

## Server Runtime Details (Required)
For Python stdio servers, always run with:
1. `command`: venv Python executable.
2. `args`: `-u -m <pythonModule> ...`.
3. `env`: 
   1. `PYTHONUNBUFFERED=1`.
   2. `VIRTUAL_ENV=<venvPath>`.
   3. `PATH=<venvPath>/bin:<existing PATH>`.

This matches the stdio transport expectations and keeps stderr logging intact in `MCPService`.

## Security Requirements (Required)
1. Do not invoke pip with interpolated shell strings. Use `execFile` or `spawn` with argument arrays.
2. Validate `pythonModule` and `name` as described to prevent command injection.
3. Do not allow `transportType: "streamable_http"` with `runtime: "python"` in `installPackage`.

## Testing Plan (Required)
1. Unit tests:
   1. `installPackage` rejects `runtime: "python"` without `pythonModule`.
   2. `installPackage` builds correct Python `command`, `args`, and env.
   3. `upgradePackage` does not mutate server command/args for Python runtime.
   4. `checkForUpdates` uses pip for Python runtime and npm for Node runtime.
2. Integration test:
   1. Add a minimal Python MCP stdio fixture under `mcp-api/test/fixtures/python-mcp-server`.
   2. Install it via `POST /packages/install` with `runtime: "python"` and `pythonModule`.
   3. Run `initialize` and `tools/list` via existing integration test harness.

## Build and Test Commands (Baseline)
1. Build: `npm run build` (from `mcp-api/package.json`).
2. Tests: `npm test`.

## Implementation Checklist
1. Add `runtime`, `pythonModule`, `pythonArgs`, `venvPath`, `pipIndexUrl`, `pipExtraIndexUrl` to `InstallPackageRequest` and `PackageInfo`.
2. Add Python venv creation and pip install logic in `PackageService.installPackage`.
3. Persist pip index URLs in `PackageInfo` and reuse them for upgrades/update checks.
4. Implement Python upgrade and update-check logic in `PackageService`.
5. Update `openapi-packages.json` to document Python runtime.
6. Add unit and integration tests for Python installs.
7. Run `npm run build` and `npm test`. 
8. Update `mcp-api/README.md` after implementation completes to reflect the final behavior and examples.
