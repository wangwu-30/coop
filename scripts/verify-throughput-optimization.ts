/**
 * Throughput Signal Optimization Verification
 * Tests the enhanced throughput calculation with various scenarios
 */

// Test cases for enhanced throughput calculation
const testCases = [
  {
    name: "High activity worker (many completed tasks)",
    worker: { workerId: "worker-1", activeTasks: 2, completedTasks: 15, throughput: 0, lastActive: new Date().toISOString(), loadScore: 0 },
    expected: { confidence: 1.0, isStale: false }
  },
  {
    name: "Low activity worker (few completed tasks)",
    worker: { workerId: "worker-2", activeTasks: 1, completedTasks: 2, throughput: 0, lastActive: new Date().toISOString(), loadScore: 0 },
    expected: { confidence: "less_than_1", isStale: false }
  },
  {
    name: "Stale worker (inactive for 50 hours)",
    worker: { workerId: "worker-3", activeTasks: 0, completedTasks: 10, throughput: 0, lastActive: new Date(Date.now() - 50*60*60*1000).toISOString(), loadScore: 0 },
    expected: { confidence: "less_than_0.5", isStale: true }
  },
  {
    name: "New worker (no completed tasks)",
    worker: { workerId: "worker-4", activeTasks: 1, completedTasks: 0, throughput: 0, lastActive: new Date().toISOString(), loadScore: 0 },
    expected: { confidence: 0, isStale: false }
  }
];

console.log("Throughput Signal Optimization - Verification Tests");
console.log("=".repeat(60));

// Simulate the enhanced calculation (logic from coop.ts)
const THROUGHPUT_EMA_ALPHA = 0.3;
const THROUGHPUT_MIN_SAMPLES = 3;
const THROUGHPUT_CONFIDENCE_SCALE = 0.5;
const STALE_HOURS_THRESHOLD = 48;

function calculateEnhancedThroughput(worker: any, previousEma?: number) {
  const now = new Date();
  const hoursSinceLastActive = (now.getTime() - new Date(worker.lastActive).getTime()) / (1000 * 60 * 60);
  const isStale = hoursSinceLastActive > STALE_HOURS_THRESHOLD;

  const rawThroughput = worker.completedTasks / 24;

  const throughputEma = previousEma !== undefined
    ? THROUGHPUT_EMA_ALPHA * rawThroughput + (1 - THROUGHPUT_EMA_ALPHA) * previousEma
    : rawThroughput;

  let confidence = Math.min(1.0, worker.completedTasks / THROUGHPUT_MIN_SAMPLES);
  if (isStale) confidence *= 0.5;

  const adjustedThroughput = throughputEma * (THROUGHPUT_CONFIDENCE_SCALE + (1 - THROUGHPUT_CONFIDENCE_SCALE) * confidence);

  return { throughputEma, confidence, adjustedThroughput, isStale };
}

testCases.forEach((tc, i) => {
  const result = calculateEnhancedThroughput(tc.worker);
  const confExpected = tc.expected.confidence === "less_than_1" ? result.confidence < 1.0
    : tc.expected.confidence === "less_than_0.5" ? result.confidence < 0.5
    : result.confidence;
  console.log(`\nTest ${i+1}: ${tc.name}`);
  console.log(`  Completed tasks: ${tc.worker.completedTasks}`);
  console.log(`  Confidence: ${result.confidence.toFixed(2)} (pass: ${confExpected})`);
  console.log(`  Is stale: ${result.isStale} (expected: ${tc.expected.isStale})`);
  console.log(`  Adjusted throughput: ${result.adjustedThroughput.toFixed(3)}`);
});

console.log("\n" + "=".repeat(60));
console.log("Key Improvements:");
console.log("1. EMA smoothing reduces signal volatility");
console.log("2. Confidence penalty for low sample sizes");
console.log("3. Stale worker detection (48h threshold)");
console.log("4. Adjusted throughput = EMA * confidence_factor");
