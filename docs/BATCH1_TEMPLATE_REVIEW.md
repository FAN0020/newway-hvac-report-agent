# Batch 1: manager template review

In the local app, open **Templates → New template**. Upload a `.txt`, `.md`, or `.csv` template to see unreviewed field suggestions. The parser recognizes explicit labels such as `Part number:` and list items such as `- Test result`. It does not decide whether a field is required. For `.docx`, `.pdf`, undecodable text, or text without recognizable labels, the app keeps the original file and shows a manual field definition path.

The optional **Suggest with local model** action uses the configured `HVAC_OLLAMA_MODEL` and the existing loopback Ollama provider. It is available only for reliably decoded text. Its output replaces the suggestion list, resets schema review and the contract test, and remains unreviewed. Model availability is not required to define or publish a template manually.

For every field, the manager can set the stable ID, label, section, type, allowed values, `required`, `requiredWhen`, allowed sources, critical status, technician confirmation, and explicit none or not applicable states. A critical field also requires technician confirmation. `KNOWLEDGE` means reference guidance only: knowledge cannot provide a job fact. `WORK_ORDER` prefill is accepted only for fields that allow it, and a required field with only `KNOWLEDGE` as its source is rejected.

Save reviewed rules, upload text context or choose **No context for this version**, run the contract test, then publish. The published `1.0.0` file cannot be changed or overwritten. The contract test checks schema structure and context choice; actual job values are validated in the report session. This local prototype has a shared app session rather than separate manager identities or role based authorization.
