// Defaults cover missing settings or an unavailable optional Agent.
const VIDEO_FRAME_GUIDANCE = "When needed, extract relevant video frames or select storyboard frames and upload them to this chat for visual analysis; do not rely on the transcript alone.";
export const DEFAULT_STARTUP_PROMPTS = Object.freeze({
  studyThisSitePrompt: "@ResearchTube Study the text and images of the sites in my tab group and explain in my language. Use site_list_tabs to find the current sites; download and inspect relevant images. Users may add or remove site tabs during research: check groupChanges and refresh the tab list when needed.",
  describeThisVideoPrompt: `@ResearchTube [video_link] [video_title]\nStudy this video and explain it in my language. ${VIDEO_FRAME_GUIDANCE}`
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
  let template = normalizeStartupPrompts(templates)[key];
  if (!template) throw invalid("Unknown startup prompt setting.");
  // A running Agent may still serve a pre-binding template from its startup snapshot.
  // Remove known routing clauses before substitution so page titles remain literal.
  const migrated = template.replace(/[ \t]*\b(?:Use (?:tabId|chatTabId):\s*(?:\[chat_tab_id\])?\s*(?:for async tasks)?|Your leading chatTabId:\s*(?:\[chat_tab_id\])?\s*)\./g, '');
  if (migrated !== template) {
    template = migrated.trim();
    if (key === 'describeThisVideoPrompt' && !/\bupload\b[^.!?\n]*\bframes\b/i.test(template) && !template.includes(VIDEO_FRAME_GUIDANCE)) {
      template += ` ${VIDEO_FRAME_GUIDANCE}`;
    }
  }
  // One pass: bracketed text in a page title is data, not another placeholder.
  return template.replace(/\[([a-z][a-z0-9_]*)\]/g, (_, name) => {
    if (['chat_tab_id', 'site_tab_id', 'group_id'].includes(name)) return '';
    if (!Object.hasOwn(values, name) || values[name] === undefined || values[name] === null) throw invalid(`Missing startup prompt value: [${name}].`);
    return String(values[name]);
  });
}
