import { randomUUID } from "node:crypto"

// This is an explicit, deliberately narrow legacy adapter, not an emulation
// of modern Messages semantics. Never include caller/upstream payloads in errors.
export class ChatRequestError extends Error {
  constructor(message) {
    super(`${message}; use native Messages for this request.`)
    this.name = "ChatRequestError"
    this.status = 400
    this.type = "invalid_request_error"
  }
}

export class ChatUpstreamError extends Error {
  constructor(message) {
    super(message)
    this.name = "ChatUpstreamError"
    this.status = 502
    this.type = "api_error"
  }
}

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const present = (value) => typeof value === "string" && value.trim().length > 0
const toolName = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value)
const failRequest = (message) => { throw new ChatRequestError(message) }
const failUpstream = (message) => { throw new ChatUpstreamError(message) }

function fields(value, allowed, context) {
  if (!object(value)) failRequest(`${context} must be an object`)
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    failRequest(`${context} contains fields that legacy Chat cannot represent`)
  }
}

function textOnly(content, context, separator = "\n\n") {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) failRequest(`${context} must contain text`)
  return content.map((part) => {
    const translated = translateContentPart(part)
    if (translated.type !== "text") failRequest(`${context} supports text only in legacy Chat`)
    return translated.text
  }).join(separator)
}

export function translateContentPart(part) {
  if (typeof part === "string") return { type: "text", text: part }
  if (!object(part)) failRequest("Content blocks must be objects")
  if (part.type === "text") {
    fields(part, ["type", "text"], "Text content (including cache hints and citations)")
    if (typeof part.text !== "string") failRequest("Text content must be a string")
    return { type: "text", text: part.text }
  }
  if (part.type === "image") {
    fields(part, ["type", "source"], "Image content")
    const source = part.source
    if (!object(source)) failRequest("Image source is missing")
    if (source.type === "url") {
      fields(source, ["type", "url"], "Image URL source")
      if (!present(source.url)) failRequest("Image URL source requires a nonempty string")
      let url
      try { url = new URL(source.url) } catch { failRequest("Image source requires a valid HTTP(S) URL") }
      if (!["https:", "http:"].includes(url.protocol)) failRequest("Image source requires an HTTP(S) URL")
      return { type: "image_url", image_url: { url: source.url } }
    }
    if (source.type === "base64") {
      fields(source, ["type", "media_type", "data"], "Base64 image source")
      if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(source.media_type) || !present(source.data)) {
        failRequest("Base64 image source requires supported image media_type and data")
      }
      return { type: "image_url", image_url: { url: `data:${source.media_type};base64,${source.data}` } }
    }
    failRequest("This image source is not supported by legacy Chat")
  }
  failRequest("This content block type (documents, thinking, server tools or unknown content) is not supported by legacy Chat")
}

function translateToolResult(result, images) {
  fields(result, ["type", "tool_use_id", "content", "is_error"], "Tool result")
  if (!present(result.tool_use_id)) failRequest("Tool result requires tool_use_id")
  if (result.is_error !== undefined && typeof result.is_error !== "boolean") failRequest("Tool result is_error must be boolean")
  let content
  if (typeof result.content === "string") content = result.content
  else if (result.content === undefined) content = ""
  else if (Array.isArray(result.content)) {
    content = result.content.map((part) => {
      const translated = translateContentPart(part)
      if (translated.type === "text") return translated.text
      images.push(translated)
      return "[image returned by tool — attached below]"
    }).join("\n")
  } else failRequest("Tool result content must be text or supported content blocks")
  if (result.is_error) content = `[tool result error]\n${content}`
  return { role: "tool", tool_call_id: result.tool_use_id, content }
}

export function translateMessages(messages, system) {
  if (!Array.isArray(messages)) failRequest("Messages must be an array")
  const translated = []
  if (system !== undefined) translated.push({ role: "system", content: textOnly(system, "System instructions") })
  for (const message of messages) {
    fields(message, ["role", "content"], "Message")
    const { role, content } = message
    if (!["user", "assistant", "system"].includes(role)) failRequest("Unsupported message role in legacy Chat")
    if (role === "system") {
      translated.push({ role, content: textOnly(content, "System instructions") })
      continue
    }
    if (typeof content === "string") {
      translated.push({ role, content })
      continue
    }
    if (!Array.isArray(content)) failRequest("Message content must be text or content blocks")
    if (role === "user") {
      const images = []
      const parts = []
      for (const part of content) {
        if (part?.type === "tool_result") translated.push(translateToolResult(part, images))
        else parts.push(translateContentPart(part))
      }
      if (parts.length || images.length || content.length === 0) translated.push({ role, content: [...parts, ...images] })
    } else {
      const texts = []
      const calls = []
      const ids = new Set()
      for (const part of content) {
        if (part?.type === "tool_use") {
          fields(part, ["type", "id", "name", "input"], "Assistant tool use")
          if (!present(part.id) || !toolName(part.name) || !object(part.input)) {
            failRequest("Assistant tool use requires id, a valid function name and object input")
          }
          if (ids.has(part.id)) failRequest("Assistant tool call IDs must be unique")
          ids.add(part.id)
          calls.push({ id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.input) } })
        } else texts.push(textOnly([part], "Assistant history", ""))
      }
      const result = { role, content: texts.length ? texts.join("\n") : calls.length ? null : "" }
      if (calls.length) result.tool_calls = calls
      translated.push(result)
    }
  }
  return translated
}

function translateTools(tools) {
  if (!Array.isArray(tools)) failRequest("Tools must be an array")
  const names = new Set()
  return tools.map((tool) => {
    fields(tool, ["type", "name", "description", "input_schema"], "Tool definition")
    if (tool.type !== undefined && tool.type !== "custom") failRequest("Server and unknown tool types are not supported by legacy Chat")
    if (!toolName(tool.name) || !object(tool.input_schema)) failRequest("Custom tools require a valid name and object input_schema")
    if (tool.description !== undefined && typeof tool.description !== "string") failRequest("Tool description must be a string")
    if (names.has(tool.name)) failRequest("Tool names must be unique")
    names.add(tool.name)
    return { type: "function", function: {
      name: tool.name, description: tool.description ?? "", parameters: tool.input_schema,
    } }
  })
}

function validateReasoning(request, forwardReasoning) {
  if (request.output_config !== undefined) {
    fields(request.output_config, ["effort"], "output_config (structured output is not supported)")
    if (request.output_config.effort !== undefined && !present(request.output_config.effort)) failRequest("output_config.effort must be a nonempty string")
  }
  if (request.thinking !== undefined) {
    fields(request.thinking, ["type", "budget_tokens"], "Thinking configuration")
    const thinking = request.thinking
    if (!["enabled", "disabled", "adaptive"].includes(thinking.type)) failRequest("Unsupported thinking configuration")
    if (thinking.type === "enabled") {
      if (!Number.isSafeInteger(thinking.budget_tokens) || thinking.budget_tokens <= 0) failRequest("Manual thinking requires a positive budget")
    } else if (thinking.budget_tokens !== undefined) failRequest("Only manual thinking can specify a budget")
  }
  // No verified catalog contract describes how adaptive Messages thinking maps
  // to Chat effort. Do not infer it from a model name or invent provider fields.
  // forwardReasoning:false is the explicit legacy opt-out, and affects only
  // these request knobs, never thinking history or other modern semantics.
  if (forwardReasoning && (request.thinking !== undefined || request.output_config?.effort !== undefined)) {
    failRequest("Legacy Chat cannot faithfully represent thinking/effort without a verified catalog mapping")
  }
}

export function buildChatRequest(request, { model = request?.model, modelInfo = {}, forwardReasoning = true } = {}) {
  fields(request, ["model", "messages", "system", "max_tokens", "stream", "temperature", "top_p",
    "stop_sequences", "tools", "tool_choice", "thinking", "output_config", "metadata"], "Request")
  if (!present(model)) failRequest("Model must be a nonempty string")
  if (request.stream !== undefined && typeof request.stream !== "boolean") failRequest("stream must be boolean")
  const maxTokens = request.max_tokens ?? 4096
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 0) failRequest("max_tokens must be a nonnegative integer")
  validateReasoning(request, forwardReasoning)
  const result = {
    model, messages: translateMessages(request.messages, request.system),
    max_tokens: maxTokens, stream: request.stream ?? false,
  }
  if (result.stream) result.stream_options = { include_usage: true }
  for (const key of ["temperature", "top_p"]) {
    if (request[key] !== undefined) {
      if (typeof request[key] !== "number" || !Number.isFinite(request[key]) || request[key] < 0 || request[key] > 1) {
        failRequest("Sampling parameters must be numbers between zero and one")
      }
      result[key] = request[key]
    }
  }
  if (request.stop_sequences !== undefined) {
    if (!Array.isArray(request.stop_sequences) || request.stop_sequences.length > 4 ||
        request.stop_sequences.some((stop) => !present(stop))) failRequest("Legacy Chat supports at most four nonempty stop sequences")
    result.stop = request.stop_sequences
  }
  if (request.tools !== undefined) result.tools = translateTools(request.tools)
  if (request.tool_choice !== undefined) {
    const choice = request.tool_choice
    fields(choice, ["type", "name", "disable_parallel_tool_use"], "Tool choice")
    if (!["auto", "none", "any", "tool"].includes(choice.type)) failRequest("Unsupported tool choice")
    if (choice.type !== "tool" && choice.name !== undefined) failRequest("Only a forced tool choice can specify name")
    if (choice.type === "tool") {
      if (!result.tools?.some((tool) => tool.function.name === choice.name)) failRequest("Forced tool choice must name a declared custom tool")
      result.tool_choice = { type: "function", function: { name: choice.name } }
    } else {
      if (choice.type === "any" && !result.tools?.length) failRequest("Required tool choice needs at least one custom tool")
      result.tool_choice = choice.type === "any" ? "required" : choice.type
    }
    if (choice.disable_parallel_tool_use !== undefined) {
      if (typeof choice.disable_parallel_tool_use !== "boolean") failRequest("disable_parallel_tool_use must be boolean")
      result.parallel_tool_calls = !choice.disable_parallel_tool_use
    }
  }
  if (request.metadata !== undefined) {
    fields(request.metadata, ["user_id"], "Metadata")
    if (request.metadata.user_id !== undefined) {
      if (!present(request.metadata.user_id)) failRequest("metadata.user_id must be a nonempty string")
      result.user = request.metadata.user_id
    }
  }
  return result
}

function tokenCount(value) {
  if (value === undefined) return 0
  if (!Number.isSafeInteger(value) || value < 0) failUpstream("Chat usage contains an invalid token counter")
  return value
}

export function buildAnthropicUsage(usage) {
  if (usage !== undefined && usage !== null && !object(usage)) failUpstream("Chat usage must be an object")
  if (usage?.prompt_tokens_details != null && !object(usage.prompt_tokens_details)) failUpstream("Chat prompt token details must be an object")
  const prompt = tokenCount(usage?.prompt_tokens)
  const cached = tokenCount(usage?.prompt_tokens_details?.cached_tokens)
  if (cached > prompt) failUpstream("Chat cached tokens exceed the total prompt tokens")
  return {
    input_tokens: prompt - cached,
    output_tokens: tokenCount(usage?.completion_tokens),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  }
}

function stopReason(reason) {
  if (reason === "stop") return "end_turn"
  if (reason === "tool_calls") return "tool_use"
  if (reason === "length") return "max_tokens"
  failUpstream("Chat completion has an unsupported or missing finish reason")
}

function validateFinish(reason, toolCount) {
  const stop = stopReason(reason)
  if ((reason === "tool_calls" && !toolCount) || (reason === "stop" && toolCount)) {
    failUpstream("Chat finish reason is inconsistent with the tool calls")
  }
  return stop
}

function toolInput(args) {
  if (typeof args !== "string") failUpstream("Chat tool arguments must be a JSON object string")
  let input
  try { input = JSON.parse(args) } catch { failUpstream("Chat tool arguments contain malformed JSON") }
  if (!object(input)) failUpstream("Chat tool arguments must decode to an object")
  return input
}

function toolHeader(tool) {
  toolFields(tool)
  if (!object(tool) || (tool.type !== undefined && tool.type !== "function") ||
      !present(tool.id) || !object(tool.function) || !toolName(tool.function.name)) {
    failUpstream("Chat tool call requires a valid id, function type and complete function name")
  }
}

function toolFields(tool) {
  if (!object(tool) || Object.keys(tool).some((key) => !["id", "type", "function", "index"].includes(key)) ||
      (tool.function !== undefined && (!object(tool.function) ||
        Object.keys(tool.function).some((key) => !["name", "arguments"].includes(key))))) {
    failUpstream("Chat tool call contains unsupported or malformed fields")
  }
}

function choices(data, streaming) {
  if (!object(data) || Object.hasOwn(data, "error") || !Array.isArray(data.choices)) {
    failUpstream("Chat upstream returned an error or malformed completion envelope")
  }
  if (data.choices.length !== 1 && !(streaming && data.choices.length === 0 && object(data.usage))) {
    failUpstream("Chat completion must contain exactly one choice, or a streaming usage tail")
  }
  const choice = data.choices[0]
  if (choice !== undefined && (!object(choice) || (choice.index !== undefined && choice.index !== 0))) {
    failUpstream("Chat completion has an invalid choice")
  }
  const allowed = ["index", "finish_reason", "logprobs", streaming ? "delta" : "message"]
  if (choice && Object.keys(choice).some((key) => !allowed.includes(key))) {
    failUpstream("Chat choice contains an error or unsupported result fields")
  }
  return choice
}

function messageFields(message, streaming) {
  if (!object(message)) failUpstream("Chat completion has no valid message or delta")
  const allowed = ["role", "content", "tool_calls"]
  for (const key of Object.keys(message)) {
    // Null refusal and empty annotations are non-semantic provider metadata.
    if ((key === "refusal" && message[key] === null) ||
        (key === "annotations" && Array.isArray(message[key]) && message[key].length === 0)) continue
    if (!allowed.includes(key)) failUpstream("Chat message contains unsupported content (including reasoning, refusal or multimodal output)")
  }
  if (message.role !== undefined && message.role !== "assistant") failUpstream("Chat completion role must be assistant")
  if (message.content != null && typeof message.content !== "string") failUpstream("Chat message content must be text")
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) failUpstream("Chat tool_calls must be an array")
  if (!streaming && typeof message.content !== "string" && !message.tool_calls?.length) failUpstream("Chat completion contains neither text nor tools")
}

export function translateResponseToAnthropic(response, model) {
  const choice = choices(response, false)
  const message = choice.message
  messageFields(message, false)
  const reason = validateFinish(choice.finish_reason, message.tool_calls?.length ?? 0)
  const content = []
  if (typeof message.content === "string") content.push({ type: "text", text: message.content })
  const ids = new Set()
  for (const tool of message.tool_calls ?? []) {
    toolHeader(tool)
    if (ids.has(tool.id)) failUpstream("Chat tool call IDs must be unique")
    ids.add(tool.id)
    content.push({ type: "tool_use", id: tool.id, name: tool.function.name, input: toolInput(tool.function.arguments) })
  }
  if (response.id !== undefined && !present(response.id)) failUpstream("Chat completion id must be a nonempty string")
  return {
    id: response.id ?? `msg_${randomUUID()}`, type: "message", role: "assistant", model, content,
    stop_reason: reason, stop_sequence: null, usage: buildAnthropicUsage(response.usage),
  }
}

// Synchronous complete-frame writer. The caller collects frames and awaits
// actual downstream writes between processChunk calls; this never awaits I/O.
export function createStreamTranslator(model, res) {
  let messageId = `msg_${randomUUID()}`
  let started = false
  let completed = false
  let failure
  let finish
  let usage = {}
  let nextIndex = 0
  let textIndex = null
  const tools = new Map()
  const ids = new Set()

  function send(type, data = {}) {
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  }
  function start() {
    if (started) return
    started = true
    send("message_start", { message: {
      id: messageId, type: "message", role: "assistant", model, content: [],
      stop_reason: null, stop_sequence: null, usage: { ...buildAnthropicUsage(usage), output_tokens: 0 },
    } })
  }
  function closeText() {
    if (textIndex === null) return
    send("content_block_stop", { index: textIndex })
    textIndex = null
  }
  function terminal() {
    if (!finish) failUpstream("Chat stream is incomplete: no valid completion finish reason before EOF or DONE")
    const reason = validateFinish(finish, tools.size)
    // Validate EVERY call before closing ANY tool block. A truncated call must
    // never be presented as a completed executable tool (not even on length).
    for (const tool of tools.values()) toolInput(tool.arguments)
    const finalUsage = buildAnthropicUsage(usage)
    start()
    closeText()
    for (const tool of tools.values()) send("content_block_stop", { index: tool.index })
    send("message_delta", { delta: { stop_reason: reason, stop_sequence: null }, usage: finalUsage })
    send("message_stop")
    completed = true
    return true
  }
  function process(chunk) {
    if (failure) throw failure
    if (completed) {
      if (chunk === null || chunk === "[DONE]") return true
      failUpstream("Chat data arrived after terminal completion")
    }
    if (chunk === null || chunk === "[DONE]") return terminal()
    let data = chunk
    if (typeof chunk === "string") {
      try { data = JSON.parse(chunk) } catch { failUpstream("Chat stream contains malformed JSON") }
    }
    const choice = choices(data, true)
    if (data.id !== undefined) {
      if (!present(data.id) || (started && data.id !== messageId)) failUpstream("Chat stream has an invalid or changing message id")
      messageId = data.id
    }
    if (data.usage != null) {
      if (!object(data.usage)) failUpstream("Chat streaming usage must be an object")
      const details = data.usage.prompt_tokens_details
      if (details != null && !object(details)) failUpstream("Chat prompt token details must be an object")
      usage = { ...usage, ...data.usage,
        prompt_tokens_details: { ...usage.prompt_tokens_details, ...details },
      }
      buildAnthropicUsage(usage)
    }
    if (!choice) return false
    const delta = choice.delta
    messageFields(delta, true)
    if (finish !== undefined && (Object.keys(delta).length || (choice.finish_reason != null && choice.finish_reason !== finish))) {
      failUpstream("Chat content or a conflicting finish reason arrived after completion intent")
    }
    if (choice.finish_reason != null) stopReason(choice.finish_reason)
    start()
    if (delta.content) {
      if (textIndex === null) {
        textIndex = nextIndex++
        send("content_block_start", { index: textIndex, content_block: { type: "text", text: "" } })
      }
      send("content_block_delta", { index: textIndex, delta: { type: "text_delta", text: delta.content } })
    }
    for (const tool of delta.tool_calls ?? []) {
      toolFields(tool)
      if (!object(tool) || !Number.isSafeInteger(tool.index) || tool.index < 0 ||
          (tool.type !== undefined && tool.type !== "function") ||
          (tool.function !== undefined && !object(tool.function))) {
        failUpstream("Chat streaming tool delta has an invalid index or function shape")
      }
      let buffer = tools.get(tool.index)
      if (!buffer) {
        toolHeader(tool)
        if (ids.has(tool.id)) failUpstream("Chat streaming tool call IDs must be unique")
        ids.add(tool.id)
        closeText()
        buffer = { index: nextIndex++, id: tool.id, name: tool.function.name, arguments: "" }
        tools.set(tool.index, buffer)
        send("content_block_start", { index: buffer.index,
          content_block: { type: "tool_use", id: buffer.id, name: buffer.name, input: {} },
        })
      } else {
        // Once a header is emitted it cannot be renamed in Anthropic SSE.
        // Reject fragmented/repeated headers instead of executing a prefix.
        if ((tool.id !== undefined && tool.id !== "") ||
            (tool.function?.name !== undefined && tool.function.name !== "")) {
          failUpstream("Fragmented or repeated Chat tool id/name headers are unsupported")
        }
        closeText()
      }
      const args = tool.function?.arguments
      if (args !== undefined) {
        if (typeof args !== "string") failUpstream("Chat streaming tool arguments must be JSON string fragments")
        buffer.arguments += args
        if (args) send("content_block_delta", { index: buffer.index, delta: { type: "input_json_delta", partial_json: args } })
      }
    }
    if (choice.finish_reason != null) {
      validateFinish(choice.finish_reason, tools.size)
      finish = choice.finish_reason
    }
    return false
  }
  return {
    processChunk(chunk) {
      try { return process(chunk) } catch (error) {
        // Latch the failure; later EOF/DONE must not turn a failed stream into
        // success. This catch propagates errors, never substitutes content.
        failure = error
        throw error
      }
    },
  }
}
