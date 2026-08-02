// Test files construct their own isolated cooperation roots. A developer may
// legitimately export AGENT_COOP_DIR for daily work; never let that ambient
// deployment setting redirect fixtures into the live coordination checkout.
delete process.env.AGENT_COOP_DIR;
delete process.env.AGENT_COOP_AGENT_ID;
