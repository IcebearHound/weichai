# Signal Buffer

Signal Buffer is a fully synthetic TypeScript library for keyed market requests, account-lane execution, audit batching, retry scheduling, packet assembly, dependency planning, and segment maintenance.

## Toolchain

- Language: TypeScript 5.x on Node.js 20+
- License: MIT
- Runtime dependencies: none
- Build: `npm install && npm run build`
- Tests: `npm test`
- Lint: `npm run lint`

The source is divided into cohesive stateful subsystems. Each module has its own domain contract and data structure; modules exchange the immutable types in `domain.ts`.
