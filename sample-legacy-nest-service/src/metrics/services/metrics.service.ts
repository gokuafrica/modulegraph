import { Injectable } from '@nestjs/common';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/** Prometheus metrics of the service: HTTP requests, Kafka messages, DB queries. Scraped at GET /metrics. */
@Injectable()
export class MetricsService {
  private readonly registry = new Registry();
  private readonly requestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'path', 'status'],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly requests = new Counter({ name: 'http_requests_total', help: 'HTTP requests', labelNames: ['method', 'path'], registers: [this.registry] });
  private readonly responses = new Counter({ name: 'http_responses_total', help: 'HTTP responses by status class', labelNames: ['method', 'path', 'status_class'], registers: [this.registry] });
  private readonly errors = new Counter({ name: 'http_errors_total', help: 'Errors thrown by handlers', labelNames: ['method', 'path', 'error'], registers: [this.registry] });
  private readonly inFlight = new Gauge({ name: 'http_requests_in_flight', help: 'Requests being served', labelNames: ['method', 'path'], registers: [this.registry] });
  private readonly kafkaMessages = new Counter({ name: 'kafka_messages_total', help: 'Kafka messages handled', labelNames: ['consumer', 'outcome'], registers: [this.registry] });
  private readonly dbQueries = new Histogram({ name: 'db_query_duration_seconds', help: 'DB query duration', labelNames: ['database', 'operation'], registers: [this.registry] });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  startRequestTimer(method: string, path: string): () => number {
    return this.requestDuration.startTimer({ method, path });
  }

  countRequest(method: string, path: string) {
    this.requests.inc({ method, path });
  }

  observeLatency(method: string, path: string, status: number, seconds: number) {
    this.requestDuration.observe({ method, path, status: String(status) }, seconds);
  }

  handleStatusCode(method: string, path: string, status: number) {
    const statusClass = status >= 500 ? '5xx' : status >= 400 ? '4xx' : status >= 300 ? '3xx' : '2xx';
    this.responses.inc({ method, path, status_class: statusClass });
  }

  countError(method: string, path: string, error: string) {
    this.errors.inc({ method, path, error });
  }

  trackInFlight(method: string, path: string, delta: number) {
    this.inFlight.inc({ method, path }, delta);
  }

  recordKafkaMessage(consumer: string, outcome: 'ok' | 'failed') {
    this.kafkaMessages.inc({ consumer, outcome });
  }

  observeDbQuery(database: string, operation: string, seconds: number) {
    this.dbQueries.observe({ database, operation }, seconds);
  }

  getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
