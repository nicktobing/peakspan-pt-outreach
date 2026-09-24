export type ContactEvent = "follow_succeeded" | "comment_1_succeeded" | "comment_2_succeeded" |
  "comment_3_succeeded" | "dm_succeeded" | "response_detected" | "opt_out" | "move_to_cold";

// Provider-success events may only be emitted after a confirmed provider result.
export function contactTransition(event: ContactEvent) {
  const successTags = { follow_succeeded: "ig-followed", comment_1_succeeded: "ig-comment-1",
    comment_2_succeeded: "ig-comment-2", comment_3_succeeded: "ig-comment-3", dm_succeeded: "ig-dm-sent" };
  if (event in successTags) return { add: [successTags[event as keyof typeof successTags]], remove: [] as string[], stage: null, suppress: false };
  switch (event) {
    case "response_detected": return { add: ["responded"], remove: ["outreach-sent"], stage: "Responded", suppress: true };
    case "opt_out": return { add: ["opted-out"], remove: ["outreach-sent"], stage: null, suppress: true };
    case "move_to_cold": return { add: ["cold"], remove: ["outreach-sent"], stage: "Cold", suppress: true };
    default: throw new Error("Invalid contact transition");
  }
}

export function reconcileTags(existing: string[], add: string[], remove: string[] = []) {
  const removed = new Set(remove);
  return [...new Set([...existing.filter((tag) => !removed.has(tag)), ...add])];
}

