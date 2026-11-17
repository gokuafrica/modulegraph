# In-house packages (for sample-legacy-nest-service)

Stand-ins for a company's private npm packages. modulegraph has no adapter for them: they are "unknown" packages,
like the ones every real service depends on. Each folder has its TypeScript source (`src/`) and the tarball that
the sample installs (`npm pack` of the compiled `dist/`), so `node_modules/@acme/*` holds compiled JavaScript and
`.d.ts` files, as it would from a private registry.

- `@acme/nestjs-kafkajs` 3.0.0: `KafkaJsService` (`producer(options)` returns an `AcmeAvroProducer` whose
  `send({ subject, topic, messages })` encodes with Avro; `sendMessage`, `consumeBatch`), `AvroProducer.send(topic,
  payload)` (the 2.x API), the `AvroKafkaMessage` type. Depends on `kafkajs`.
- `@acme/typeorm-outbox-writer` 2.0.0: `TypeORMOutboxService.createOutboxMessage(message, manager)`, the older
  `OutboxWriter.write(queryRunner, eventType, payload)`.
- `@acme/nestjs-logging`: `AcmeLogger`.

Rebuild after editing a package: `npx tsc -p packages/<name> && (cd packages/<name> && npm pack)`, then `npm install` in `sample-legacy-nest-service` (it has its own lockfile).
