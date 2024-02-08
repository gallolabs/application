import { loadConfig, ConfigOpts, WatchChangesEventEmitter } from '@gallolabs/config'
import { createLogger, Logger, LoggerOpts, ConsoleHandler, BreadCrumbHandler, createJsonFormatter, createLogfmtFormatter } from '@gallolabs/logger'
import EventEmitter from 'events'
import shortUuid from 'short-uuid'
import { FromSchema, JSONSchema } from 'json-schema-to-ts'
import { MetricsRegistry, MetricsUserFriendlyInterface, MetricsServer, MetricsFormatter } from './metrics.js'

export const baseConfigSchema = {
    type: 'object',
    properties: {
        log: {
            type: 'object',
            default: {},
            properties: {
                // Todo import from logger
                level: { enum: ['fatal', 'error', 'warning', 'info', 'debug'], default: 'info' },
                format: { enum: ['json', 'logfmt'], default: 'json' }
            },
            required: ['level', 'format'],
            additionalProperties: false
        },
        dryRun: {
            type: 'boolean',
            default: false
        }
    },
    required: ['log', 'dryRun'],
    additionalProperties: false
} as const satisfies JSONSchema

export type BaseConfig = FromSchema<typeof baseConfigSchema>

export enum ExitCodes {
    unexpected=1,
    invalidConfig=2,
    appError=3,
    appAbort=4,
    providedSignalAbort=5,
    SIGTERM=143,
    SIGINT=130
}

export type UidGenerator = () => string

export type InjectedServices<Config extends BaseConfig> = {
    logger: Logger
    config: Config
    name: string
    version: string
    container: Services<Config>
    configWatcher: WatchChangesEventEmitter<Config>
    abortController: AbortController
    abortSignal: AbortSignal
    uidGenerator: UidGenerator
    metrics: MetricsUserFriendlyInterface
}

export type Services<Config extends BaseConfig> = Record<keyof ServicesDefinition<Config>, any> & InjectedServices<Config>

type ReservedServicesNames = keyof InjectedServices<any>

export type ServicesDefinition<Config extends BaseConfig> = Record<Exclude<string, ReservedServicesNames>, ServiceDefinition<any, Config>>

export type ServiceDefinition<T, Config extends BaseConfig> = (services: Services<Config>) => T

export type RunHandler<Config extends BaseConfig> = (services: Services<Config>) => void

export interface AppDefinition<Config extends BaseConfig> {
    name: string
    version: string
    consoleUse?: 'accepted' | 'to-log' | 'block&warn' | 'block'
    config?: Omit<ConfigOpts<Config>, 'logger' | 'watchChanges'> & { watchChanges?: boolean }
    logger?: Omit<LoggerOpts, 'handlers' | 'errorHandler' | 'id'>
    services?: ServicesDefinition<Config>
    run: RunHandler<Config>
}

function createDiContainer(builtinServices: Omit<InjectedServices<any>, 'container'>, servicesDefinition: ServicesDefinition<any>): Services<any> {
    const buildingSymbol = Symbol('building')

    const myself: Services<any> = new Proxy({...builtinServices} as InjectedServices<any>, {
        get(services: Services<any>, serviceName: string) {
            if (!services[serviceName]) {
                if (!servicesDefinition[serviceName]) {
                    throw new Error('Unknown service ' + serviceName)
                }
                services[serviceName] = buildingSymbol
                services[serviceName] = servicesDefinition[serviceName](myself)
            }

            if (services[serviceName] === buildingSymbol) {
                throw new Error('Cyclic injections detected')
            }

            return services[serviceName]
        }
    }) as Services<any>

    myself.container = myself

    return myself
}

class App<Config extends BaseConfig> {
    //protected status: 'READY' | 'RUNNING' = 'READY'
    protected alreadyRun: boolean = false
    protected name: string
    protected version: string
    protected config?: Config
    protected logger?: Logger
    protected services?: Services<Config>
    protected runFn: RunHandler<Config>
    protected abortController = new AbortController
    protected appDefinition: AppDefinition<Config>

    constructor(appDefinition: AppDefinition<Config>) {
        this.name = appDefinition.name
        this.version = appDefinition.version
        this.runFn = appDefinition.run
        this.appDefinition = appDefinition
    }

    public async run(abortSignal?: AbortSignal) {
        if (this.alreadyRun) {
            throw new Error('Application already run')
        }

        this.alreadyRun = true

        if (abortSignal?.aborted) {
            return
        }

        abortSignal?.addEventListener('abort', (reason) => {
            fwkLogger.info('Abort requested by provided signal ; aborting', {reason})
            this.abortController.abort()
        }, {signal: this.abortController.signal})

        const uidGenerator = () => shortUuid.generate().substring(0, 10)
        const runUid = uidGenerator()

        const loggerHandler = new BreadCrumbHandler({
            handler: new ConsoleHandler({
                maxLevel: 'debug',
                minLevel: 'fatal',
                formatter: createJsonFormatter()
            }),
            flushMaxLevel: 'warning',
            passthroughMaxLevel: 'debug'
        })

        this.logger = createLogger({
            ...this.appDefinition.logger,
            metadata: {
                ...this.appDefinition.logger?.metadata || {},
                [this.name + 'Version']: this.version,
                [this.name + 'RunUid']: runUid,
                appName: this.name,
            },
            id: this.name,
            //id: 'app_' + uuid().split('-')[0],  //{ name: 'app', uid: uuid() },
            handlers: [loggerHandler],
            onError(error) {
                // TODO add protection to avoid infinite loop
                fwkLogger.error('Logging error', {error})
            }
        })

        //const nodeLogger = this.logger.sibling('node')

        const fwkLogger = this.logger.child('fwk')

        const onWarning = async(warning: Error) => {
            await /*nodeLogger*/fwkLogger.warning(warning.message, {warning})
        }

        // Hack because I don't know why, this event listener is registered again
        // On first call. The code is called twice with listenerCount() to 1 then 2
        const handledRejections: Error[] = []
        const onUnhandledRejection = async(reason: Error) => {
            if (handledRejections.includes(reason as Error)) {
                return
            }

            handledRejections.push(reason as Error)

            await /*nodeLogger*/fwkLogger.fatal(reason.message, {reason})
            this.abortController.abort() // Maybe bad idea
            // TODO add protection to avoid infinite idle if logger is cause of rejection and did'nt decrement counter
            await fwkLogger.waitForIdle()

            process.exit(ExitCodes.unexpected) // Not mandatory, but how to know the impact of the rejection ?
        }

        const onUncaughtException = async(err: Error, origin: NodeJS.UncaughtExceptionOrigin) => {
            await /*nodeLogger*/fwkLogger.fatal(err.message, {err, origin})
            this.abortController.abort() // Maybe bad idea
            // TODO add protection to avoid infinite idle if logger is cause of rejection and did'nt decrement counter
            await fwkLogger.waitForIdle()
            process.exit(ExitCodes.unexpected)
        }

        const onProcessExit = async (code: number) => {
            await fwkLogger.fatal('Unexpected process exit', {code})
        }

        const signalsToHandle = ['SIGTERM', 'SIGINT']
        let receivedSignal: 'SIGTERM' | 'SIGINT' | undefined
        const onProcessSignal = async (signal: 'SIGTERM' | 'SIGINT') => {
            receivedSignal = signal
            fwkLogger.info('Process receives signal ' + signal + ' ; aborting')
            this.abortController.abort()
        }

        signalsToHandle.forEach(signal => process.once(signal, onProcessSignal))
        process.on('warning', onWarning)
        process.on('unhandledRejection', onUnhandledRejection)
        process.on('uncaughtException', onUncaughtException)
        process.on('exit', onProcessExit)

        this.abortController.signal.addEventListener('abort', () => {
            process.off('warning', onWarning)
            process.off('unhandledRejection', onUnhandledRejection)
            process.off('uncaughtException', onUncaughtException)
            process.off('exit', onProcessExit)
            signalsToHandle.forEach(signal => process.off(signal, onProcessSignal))
        })

        const defaultConfigArgs: Pick<ConfigOpts<any>, 'schema' | 'defaultFilename' | 'envFilename' | 'envPrefix'> = {
            schema: baseConfigSchema,
            defaultFilename: '/etc/' + this.name + '/config.yaml',
            envFilename: this.name + '_CONFIG_PATH',
            envPrefix: this.name,
        }

        const watchEventEmitter = new EventEmitter

        if (this.appDefinition.config?.watchChanges) {
            watchEventEmitter.on('error', (error: Error) => {
                fwkLogger.warning('Config watch error', {error})
            })
            watchEventEmitter.on('change', ({patch}) => {
                fwkLogger.info('Configuration change detected', { changes: patch })
            })
        }

        try {
            this.config = await loadConfig<Config>({
                ...defaultConfigArgs,
                ...this.appDefinition.config,
                watchChanges: this.appDefinition.config?.watchChanges
                    ? {
                        abortSignal: this.abortController.signal,
                        eventEmitter: watchEventEmitter
                    }
                    : undefined
            })
        } catch (error) {
            fwkLogger.fatal('Config load fails', {
                error,
                schema: this.appDefinition.config?.schema
            })
            process.exitCode = ExitCodes.invalidConfig
            this.abortController.abort()
            return
        }

        if (!this.config!.log?.level) {
            fwkLogger.fatal('Unexpected not loaded BaseConfig (development problem)')
            process.exitCode = ExitCodes.unexpected
            this.abortController.abort()
            return
        }

        loggerHandler.setLevels({passthroughMaxLevel: this.config!.log.level})
        loggerHandler.setFormatter(this.config!.log.format === 'json'
            ? createJsonFormatter()
            : createLogfmtFormatter()
        )

        if (this.appDefinition.config?.watchChanges) {
            watchEventEmitter.on('change:log.level', ({value}) => {
                //this.config!.log.level = value
                fwkLogger.info('Reconfigure logger level', {level: value})
                loggerHandler.setLevels({passthroughMaxLevel: value})
            })
        }

        const consoleMethods = {}
        for (const method in console) {
            // @ts-ignore
            consoleMethods[method] = console[method]
        }

        this.abortController.signal.addEventListener('abort', () => {
            for (const method in consoleMethods) {
                // @ts-ignore
                console[method] = consoleMethods[method]
            }
        })

        switch(this.appDefinition.consoleUse) {
            case 'accepted':
                break
            case 'block':
                for (const method in console) {
                    // @ts-ignore
                    console[method] = () => {}
                }
                break
            case 'to-log':
                throw new Error('todo')
                break
            case 'block&warn':
            default:
                for (const method in console) {
                    // @ts-ignore
                    console[method] = (...args) => {
                        fwkLogger.warning('Used console.' + method + ', please fix it', {args})
                    }
                }
        }

        // const metrics = createMetrics({
        //     handlers: [
        //         (() => {
        //             const logger = this.logger.child('metrics')

        //             return {
        //                 async increment(value, measurement, tags) {
        //                     logger.info(measurement.join('.') + ' +' + value, {measurement, tags, type: 'counter', value})
        //                 }
        //             }
        //         })()
        //     ],
        //     measurementPrefix: [this.name],
        //     measurementSeparator: '.'
        // })

        const metricsRegistry = new MetricsRegistry
        const metrics = new MetricsUserFriendlyInterface(metricsRegistry)
        const metricsServer = new MetricsServer({
            uidGenerator,
            formatter: new MetricsFormatter,
            registry: metricsRegistry
        })

        this.services = createDiContainer({
            config: this.config,
            logger: this.logger,
            metrics,
            name: this.name,
            version: this.version,
            configWatcher: watchEventEmitter,
            abortController: new AbortController,
            abortSignal: this.abortController.signal,
            uidGenerator
        }, this.appDefinition.services || {})

        this.services.abortController.signal.addEventListener('abort', (reason) => {
            fwkLogger.info('Abort requested by app ; aborting', {reason})
            this.abortController.abort()
        }, {signal: this.abortController.signal})

        fwkLogger.info('Running app', {
            config: this.config,
            name: this.name,
            version: this.version,
            runUid,
            logLevel: this.config!.log.level,
            logFormat: this.config!.log.format
        })

        try {
            if (this.config!.dryRun) {
                fwkLogger.info('Run skipped (dryRun)')
            } else {
                metricsServer.start(this.abortController.signal)
                // DryRun can go to the app run, but we have
                // To add a non-positive framework config to enable it ?
                await this.runFn(this.services!)
            }
            if (this.abortController.signal.aborted) {
                throw this.abortController.signal.reason
            }
            fwkLogger.info('App ended')
            process.exitCode = 0
        } catch (error) {
            if (this.abortController.signal.aborted) {

                fwkLogger.info('App aborted')

                if (abortSignal?.aborted) {
                    process.exitCode = ExitCodes.providedSignalAbort
                } else if (this.services.abortController.signal.aborted) {
                    process.exitCode = ExitCodes.appAbort
                } else if (receivedSignal) {
                    process.exitCode = ExitCodes[receivedSignal]
                } else {
                    process.exitCode = ExitCodes.unexpected
                }

                const isAbortReason = error === this.abortController.signal.reason
                const isAboutAborting = error instanceof Error && (error as Error & {cause?:any}).cause === this.abortController.signal.reason

                if (!(isAbortReason || isAboutAborting)) {
                    fwkLogger.warning('Error thrown while aborted', {error})
                }

                return
            }

            fwkLogger.fatal('App exited with error', {error})
            process.exitCode = ExitCodes.appError
        } finally {
            this.abortController.abort()
        }
    }
}

export async function runApp<Config extends BaseConfig>(appDefinition: AppDefinition<Config> & { abortSignal?: AbortSignal }) {
    return await (new App(appDefinition)).run(appDefinition.abortSignal)
}
