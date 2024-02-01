const { Counter, Registry } = require('prom-client');

const registry = new Registry();

const counter = new Counter({
  name: 'requests',
  help: 'Nb of requests'
});

counter.inc(); // Increment by 1
counter.inc(10); // Increment by 10

registry.registerMetric(counter)
registry.setContentType(
  Registry.OPENMETRICS_CONTENT_TYPE,
);

console.log(registry.contentType)
registry.metrics().then(console.log)


