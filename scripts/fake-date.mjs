// Runs the test suite as if it were months from now (FAKE_NOW, default
// +200 days), so a test that only passes for the current calendar fails today.
const Real = Date; const OFFSET = process.env.FAKE_NOW ? Real.parse(process.env.FAKE_NOW) - Real.now() : 200 * 86400000;
class FakeDate extends Real { constructor(...a) { if (a.length === 0) super(Real.now() + OFFSET); else super(...a); } static now() { return Real.now() + OFFSET; } }
globalThis.Date = FakeDate;
