// Catalog API on Fastify + Mongoose + BullMQ + fetch.
import { Queue, Worker } from 'bullmq';
import Fastify, { type FastifyInstance } from 'fastify';
import { type Model, Schema, model } from 'mongoose';

export interface ProductDoc {
  sku: string;
  name: string;
  price: number;
}

const connection = { host: 'localhost', port: 6379 };

export class SearchIndexer {
  constructor(private readonly products: Model<ProductDoc>) {}

  async index(sku: string): Promise<void> {
    const product = await this.products.findOne({ sku });
    await fetch(`https://search.example.com/v1/documents/${sku}`, { method: 'PUT', body: JSON.stringify(product) });
  }
}

export class CatalogService {
  private readonly indexQueue = new Queue('search-index', { connection });

  constructor(
    private readonly products: Model<ProductDoc>,
    private readonly indexer: SearchIndexer,
  ) {}

  async get(sku: string): Promise<ProductDoc | null> {
    return this.products.findOne({ sku }).lean();
  }

  async create(input: ProductDoc): Promise<ProductDoc> {
    const created = await this.products.create(input);
    await this.indexQueue.add('index-product', { sku: input.sku });
    return created.toObject();
  }

  async search(q: string): Promise<string[]> {
    const res = await fetch(`https://search.example.com/v1/query?q=${encodeURIComponent(q)}`);
    return ((await res.json()) as { skus: string[] }).skus;
  }

  async reindex(sku: string): Promise<void> {
    await this.indexer.index(sku);
  }
}

async function productRoutes(app: FastifyInstance, opts: { catalog: CatalogService }): Promise<void> {
  app.get<{ Params: { sku: string } }>('/:sku', async (req) => opts.catalog.get(req.params.sku));

  app.route<{ Body: ProductDoc }>({
    method: 'POST',
    url: '/',
    handler: async (req, reply) => {
      const product = await opts.catalog.create(req.body);
      reply.code(201).send(product);
    },
  });

  app.get<{ Querystring: { q: string } }>('/search', { schema: {} }, async (req) => opts.catalog.search(req.query.q));
}

export function buildCatalog(): FastifyInstance {
  const products = model<ProductDoc>('Product', new Schema<ProductDoc>({ sku: String, name: String, price: Number }));
  const indexer = new SearchIndexer(products);
  const catalog = new CatalogService(products, indexer);
  const app = Fastify();
  app.register(productRoutes, { prefix: '/v1/products', catalog });

  new Worker('search-index', async (job) => {
    await catalog.reindex(job.data.sku);
  }, { connection });
  return app;
}
