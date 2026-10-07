// Optional Agent configuration; older/offline Agents retain bounded defaults.
export const DEFAULT_BROWSER_OBSERVATION = Object.freeze({ maxNodes: 200, maxChars: 48000 });
export function browserObservationOptions(value) {
  if (value === undefined) return { ...DEFAULT_BROWSER_OBSERVATION };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("The Local Agent returned invalid browserStudyObservation."), { code: "AGENT_INVALID_RESPONSE" });
  const result = {};
  for (const [name, minimum, maximum] of [["maxNodes", 1, 1000], ["maxChars", 1000, 100000]]) {
    const selected = value[name] === undefined ? DEFAULT_BROWSER_OBSERVATION[name] : value[name];
    if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) throw Object.assign(new Error(`The Local Agent returned invalid browserStudyObservation.${name}.`), { code: "AGENT_INVALID_RESPONSE" });
    result[name] = selected;
  }
  return result;
}
