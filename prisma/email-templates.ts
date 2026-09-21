// The built-in email templates.
//
// Each one corresponds to a step the firm's real checklists already have —
// "Document Received", "Report Sent to Client", "Review done by Client",
// "Send form 8879 for signature", "Payment Received" — so the template library
// covers the moments in the workflow where somebody actually has to write to a
// client, rather than a generic set invented from nothing.
//
// Placeholders are resolved per engagement; see TEMPLATE_VARIABLES in
// src/lib/email.ts for the full list. Seeded with builtIn: true, which only
// records where they came from — they're editable like any other.
//
// Imported by prisma/seed.ts and by prisma/seed-email-templates.ts (the
// idempotent script for a database that already exists).

export const BUILT_IN_TEMPLATES: {
  key: string;
  name: string;
  description: string;
  subject: string;
  body: string;
}[] = [
  {
    key: "request-documents",
    name: "Request documents",
    description: "Opening ask for the period's paperwork",
    subject: "{{project_name}} for {{period}} — documents needed",
    body: `Hi {{contact_first_name}},

We're ready to start {{project_name}} for {{period}} at {{client_name}}.

Could you send over the following when you get a chance?

  - Bank and credit card statements for the period
  - Any receipts or invoices not already in the system
  - Anything unusual you'd like us to look at

We have this down as due {{due_date}}, so the sooner we have everything the more comfortable that timeline is.

Thanks,
{{sender_name}}
{{firm_name}}`,
  },
  {
    key: "missing-documents",
    name: "Chase missing documents",
    description: "Follow-up when the file is incomplete",
    subject: "Still waiting on a few things — {{project_name}}, {{period}}",
    body: `Hi {{contact_first_name}},

Quick follow-up on {{project_name}} for {{period}}. We're missing a few items and can't move past "{{next_task}}" until they arrive.

Could you send those across when you have a moment? The deadline on our side is {{due_date}}.

If anything on the list doesn't exist for this period, just say so and we'll note it and move on.

Thanks,
{{sender_name}}
{{firm_name}}`,
  },
  {
    key: "report-ready",
    name: "Report ready for review",
    description: "Matches the “Report Sent to Client” step",
    subject: "{{project_name}} for {{period}} is ready for your review",
    body: `Hi {{contact_first_name}},

{{project_name}} for {{period}} is finished on our side and ready for you to look over. The report is attached.

Please have a read through and let us know if anything looks off — particularly anything in the numbers you don't recognise. If it all looks right, just reply to confirm and we'll close the period out.

Thanks,
{{sender_name}}
{{firm_name}}`,
  },
  {
    key: "review-reminder",
    name: "Review reminder",
    description: "Matches the “Review done by Client” step",
    subject: "Reminder: {{project_name}} for {{period}} is waiting on you",
    body: `Hi {{contact_first_name}},

Just a reminder that {{project_name}} for {{period}} is sitting with you for review. We can't close it out until we hear back.

It's due {{due_date}}. A quick "looks good" is all we need if you're happy with it.

Thanks,
{{sender_name}}
{{firm_name}}`,
  },
  {
    key: "signature-request",
    name: "Signature request (8879)",
    description: "Matches the “Send form 8879 for signature” step",
    subject: "Signature needed before we can file — {{client_name}}",
    body: `Hi {{contact_first_name}},

Your return is prepared and ready to go. Before we can file it, we need Form 8879 signed and returned — we're not permitted to submit anything without it.

The form is attached. Please sign and send it back at your earliest convenience; the filing deadline is {{due_date}}.

Let us know if you'd like to walk through the return before signing.

Thanks,
{{sender_name}}
{{firm_name}}`,
  },
  {
    key: "deadline-reminder",
    name: "Deadline approaching",
    description: "Generic heads-up that a due date is close",
    subject: "{{project_name}} — {{period}} is due {{due_date}}",
    body: `Hi {{contact_first_name}},

A heads-up that {{project_name}} for {{period}} is due {{due_date}}, and there are still {{open_tasks}} items open on our checklist.

The next thing we need to get through is "{{next_task}}". If there's anything on your side holding that up, let us know and we'll work around it.

Thanks,
{{sender_name}}
{{firm_name}}`,
  },
  {
    key: "period-complete",
    name: "Period closed",
    description: "Wrap-up once everything is done",
    subject: "{{project_name}} for {{period}} is complete",
    body: `Hi {{contact_first_name}},

{{project_name}} for {{period}} is complete and closed on our side. Nothing further is needed from you for this period.

Your records are filed and available any time you need them. We'll be in touch when the next period comes around.

Thanks,
{{sender_name}}
{{firm_name}}`,
  },
];
