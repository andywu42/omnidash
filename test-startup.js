// Test script to verify lazy initialization works
import('dotenv').then(({ config }) => {
  // Remove Kafka config
  delete process.env.KAFKA_BROKERS;
  delete process.env.KAFKA_BOOTSTRAP_SERVERS;

  console.log('Testing EventConsumer lazy initialization...');

  // Import event-consumer module
  import('./server/event-consumer.ts').then((module) => {
    console.log('✅ Module loaded successfully (no crash at import time)');

    // Test getEventConsumer function
    const consumer = module.getEventConsumer();
    if (consumer === null) {
      console.log('✅ getEventConsumer() returns null when Kafka not configured (expected)');
    } else {
      console.log('❌ getEventConsumer() should return null when Kafka not configured');
      process.exit(1);
    }

    // Test error retrieval
    const error = module.getEventConsumerError();
    if (error) {
      console.log('✅ getEventConsumerError() returns error:', error.message);
    }

    // Test backward compatible proxy
    console.log('Testing backward compatibility proxy...');
    const proxyConsumer = module.eventConsumer;

    // Test method calls (should not crash)
    const health = proxyConsumer.getHealthStatus();
    console.log('✅ eventConsumer.getHealthStatus() works:', health);

    const metrics = proxyConsumer.getAgentMetrics();
    console.log('✅ eventConsumer.getAgentMetrics() works:', metrics.length, 'metrics');

    console.log('\n✅ All tests passed! Lazy initialization works correctly.');
    process.exit(0);
  }).catch((err) => {
    console.error('❌ Failed to import event-consumer:', err);
    process.exit(1);
  });
});
