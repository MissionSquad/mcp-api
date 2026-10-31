# Execution candidate image publication

The `Publish execution GHCR candidate` workflow is limited to the authorized `codex/execution-invocation` branch, with an optional dispatch on that same ref. It uses the organization's self-hosted Linux/x64 Proxmox Docker builders. Required PR checks and the existing main release workflow remain unchanged.

Only the exact tracked commit is used as build context, excluding local untracked environment files and Git credentials/history. The built image is syntax-checked and runs the existing execution invocation test without network access. A SHA/run/attempt-specific `candidate-sha-*` tag and actual GHCR digest are recorded in a retained JSON artifact and run summary. The same tested engine identity is pushed; neither `latest` nor version release tags are updated.

This workflow has no deployment, Google Cloud, S3, npm publication, production secret, or production-activation step. Findings or an image's publication do not imply production approval. Core is a separate private library and is not distributed by this public repository's candidate workflow.
