# In-house packages (for sample-legacy-nest-service)

Stand-ins for a company's private npm packages. modulegraph has no adapter for them: they are "unknown" packages,
like the ones every real service depends on. Each folder has its TypeScript source (`src/`) and the tarball that
the sample installs (`npm pack` of the compiled `dist/`), so `node_modules/@acme/*` holds compiled JavaScript and
`.d.ts` files, as it would from a private registry.

- `@acme/nestjs-kafkajs`: `KafkaJsService` (`sendMessage`, `consume`), `AvroProducer.send(topic, payload)`,
  `BaseConsumerHandler`. Depends on `kafkajs`.
- `@acme/typeorm-outbox-writer`: `OutboxWriter.write(queryRunner, eventType, payload)`.
- `@acme/nestjs-logging`: `AcmeLogger`.

Rebuild after editing a package: `npx tsc -p packages/<name> && (cd packages/<name> && npm pack)`, then `npm install`.
