/*
* Guide https://github.com/OpenObservability/OpenMetrics/blob/main/specification/OpenMetrics.md
*/
import { Counter, CounterConfiguration, Registry, openMetricsContentType } from 'prom-client'
import Fastify, { FastifyInstance } from 'fastify'

export type CounterOpts = Omit<CounterConfiguration<any>, 'registers' | 'aggregator'>

export class MetricsRegistry {
    protected promRegistry = new Registry

    public createCounter(configuration: CounterOpts) {
        const counter = new Counter(configuration)
        this.promRegistry.registerMetric(counter)

        return counter
    }
}

export class MetricsServer {
    protected registry: MetricsRegistry
    protected server: FastifyInstance

    public constructor({registry, uidGenerator}: {registry: MetricsRegistry, uidGenerator: () => string}) {
        this.registry = registry
        this.server = Fastify({
            genReqId: uidGenerator
        })

        this.server.addHook('onRequest', async (request) => {
            // Todo add logs on fwk scope (.metrics)
          //console.log(request.id, request.url, request)
        })

        // Bad arch : Registry and dumper should not be the same
        const promRegistry = this.registry['promRegistry']
        // Cool ... Typescript is pooply implemented
        promRegistry.setContentType(openMetricsContentType as any)

        this.server.get('/metrics', async (_, reply) => reply.type(openMetricsContentType).send(await promRegistry.metrics()))
    }

    public async start(abortSignal?: AbortSignal) {
        // Warn listening can probably be false even if start has been called. To fix
        if (this.server.server.listening) {
            throw new Error('Server already running')
        }

        await this.server.listen({port: 9090, signal: abortSignal})
    }

    public async stop() {
        await this.server.close()
    }
}