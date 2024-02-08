/*
* Guide https://github.com/OpenObservability/OpenMetrics/blob/main/specification/OpenMetrics.md
*/
import { Counter, CounterConfiguration, Gauge, GaugeConfiguration, Metric, Registry as PromRegistry, openMetricsContentType } from 'prom-client'
import Fastify, { FastifyInstance } from 'fastify'

export type CounterOpts = Omit<CounterConfiguration<any>, 'registers' | 'aggregator'>
export type GaugeOpts = Omit<GaugeConfiguration<any>, 'registers' | 'aggregator'>

export class MetricsUserFriendlyInterface {
    protected registry: MetricsRegistry

    public constructor(registry: MetricsRegistry) {
        this.registry = registry
    }

    public createCounter(configuration: CounterOpts) {
        const counter = new Counter(configuration)
        this.registry.register(counter)

        return counter
    }

    public createGauge(configuration: GaugeOpts) {
        const gauge = new Gauge(configuration)
        this.registry.register(gauge)

        return gauge
    }
    // public child/scope (prefix) => Sub Class of MetricsRegistry without all methods and targetting same promRegistry ?
}

export class MetricsRegistry {
    protected promRegistry = new PromRegistry

    public register(metric: Metric) {
        this.promRegistry.registerMetric(metric)
    }
}

export class MetricsFormatter {
    public async format(registry: MetricsRegistry) {
        // Bad arch : Registry and dumper should not be the same
        const promRegistry = registry['promRegistry']
        // Cool ... Typescript is pooply implemented
        promRegistry.setContentType(openMetricsContentType as any)

        return await promRegistry.metrics()
    }
}

export class MetricsServer {
    protected registry: MetricsRegistry
    protected formatter: MetricsFormatter
    protected server: FastifyInstance

    public constructor(
        {registry, uidGenerator, formatter}:
        {registry: MetricsRegistry, formatter: MetricsFormatter, uidGenerator: () => string}
    ) {
        this.registry = registry
        this.formatter = formatter
        this.server = Fastify({
            genReqId: uidGenerator
        })

        this.server.addHook('onRequest', async (_request) => {
            // Todo add logs on fwk scope (.metrics)
          //console.log(request.id, request.url, request)
        })

        this.server.addHook('onResponse', async (_, reply) => {
            // "As a rule of thumb, exposition SHOULD take no more than a second."
            if (reply.elapsedTime > 1000) {
                // PAS BIEN
            }
        })

        this.server.get('/metrics', async (_, reply) => reply.type(openMetricsContentType).send(await this.formatter.format(this.registry)))
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