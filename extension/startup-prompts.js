// Browser-only defaults also support an offline Agent or an older config.
export const DEFAULT_STARTUP_PROMPTS = Object.freeze({
  studyThisSitePrompt: "@ResearchTube Study the text and images of the sites in my tab group. Download and inspect relevant images when available, then explain in my language. Use chatTabId: [chat_tab_id].",
  describeThisVideoPrompt: "@ResearchTube [video_title] [video_link]\nStudy this video and explain it in my language. Use tabId: [chat_tab_id] for async tasks."
});
const PLACEHOLDERS = Object.freeze({
  studyThisSitePrompt: ["chat_tab_id", "site_tab_id", "site_title", "site_link", "group_id"],
  describeThisVideoPrompt: ["chat_tab_id", "video_title", "video_link"]
});

function invalid(message) {
  return Object.assign(new Error(message), { code: "AGENT_INVALID_RESPONSE" });
}

export function normalizeStartupPrompts(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !Object.hasOwn(PLACEHOLDERS, key))) {
    throw invalid("The Local Agent returned invalid startup prompt settings.");
  }
  const result = { ...DEFAULT_STARTUP_PROMPTS };
  for (const [key, template] of Object.entries(value)) {
    if (typeof template !== "string" || !template.trim() || [...template].length > 16000) {
      throw invalid(`${key} must contain 1–16000 characters of prompt text.`);
    }
    for (const match of template.matchAll(/\[([a-z][a-z0-9_]*)\]/g)) {
      if (!PLACEHOLDERS[key].includes(match[1])) throw invalid(`${key} contains an unknown placeholder: [${match[1]}].`);
    }
    result[key] = template;
  }
  return result;
}

export function renderStartupPrompt(key, templates, values) {
  const template = normalizeStartupPrompts(templates)[key];
  if (!template) throw invalid("Unknown startup prompt setting.");
  // One pass: bracketed text in a page title is data, not another placeholder.
  return template.replace(/\[([a-z][a-z0-9_]*)\]/g, (_, name) => {
    if (!Object.hasOwn(values, name) || values[name] === undefined || values[name] === null) throw invalid(`Missing startup prompt value: [${name}].`);
    return String(values[name]);
  });
}
