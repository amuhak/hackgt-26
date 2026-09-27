// The two realtime voice APIs behind one small interface. Both take and return
// 24 kHz PCM16 as base64; the agent owns audio, tools and UI.

export type ToolDef = { name: string; description: string; parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] } };
export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

export type Handlers = {
  audio(b64: string): void;
  agentText(text: string, key: string): void; // full text so far for this reply
  userText(text: string, key: string): void; // full text so far for this user turn
  toolCalls(calls: ToolCall[]): void;
  userSpeaking(): void; // barge-in: stop playback
  userStopped(): void;
  replying(): void;
  turnDone(): void;
  closed(reason: string | null): void; // null: we closed it
  error(msg: string): void;
};

export type Session = { model: string; voice: string; instructions: string; tools: ToolDef[]; token: string; thinking?: string | null };

export interface Transport {
  open(s: Session, h: Handlers): Promise<void>;
  audio(b64: string): void;
  text(t: string): void;
  toolResults(results: { id: string; name: string; output: unknown }[]): void;
  close(): void;
}

abstract class WsTransport implements Transport {
  protected ws: WebSocket | null = null;
  protected h!: Handlers;
  private closing = false;

  protected connect(url: string, protocols: string[] | undefined, onOpen: () => void, onMsg: (m: Record<string, any>) => void) {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, protocols);
      this.ws = ws;
      let ready = false;
      this.ready = () => {
        ready = true;
        resolve();
      };
      ws.onopen = onOpen;
      ws.onmessage = async (ev) => {
        const raw = typeof ev.data === "string" ? ev.data : await (ev.data as Blob).text();
        onMsg(JSON.parse(raw));
      };
      ws.onclose = (ev) => {
        const why = `Voice connection closed (${ev.code}${ev.reason ? ": " + ev.reason : ""})`;
        if (!ready) reject(new Error(why));
        else this.h.closed(this.closing ? null : why);
        this.ws = null;
      };
    });
  }
  protected ready = () => {};

  protected send(m: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  close() {
    this.closing = true;
    this.ws?.close();
  }

  abstract open(s: Session, h: Handlers): Promise<void>;
  abstract audio(b64: string): void;
  abstract text(t: string): void;
  abstract toolResults(results: { id: string; name: string; output: unknown }[]): void;
}

/** xAI realtime (OpenAI-realtime style events). */
export class GrokTransport extends WsTransport {
  private responding = false;
  private needResponse = false; // tool outputs sent, model hasn't been asked to continue
  private outstanding = 0; // tool calls still running

  open(s: Session, h: Handlers) {
    this.h = h;
    return this.connect(
      `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(s.model)}`,
      [`xai-client-secret.${s.token}`],
      () => {
        this.send({
          type: "session.update",
          session: {
            voice: s.voice,
            instructions: s.instructions,
            turn_detection: { type: "server_vad" },
            audio: { input: { format: { type: "audio/pcm", rate: 24000 } }, output: { format: { type: "audio/pcm", rate: 24000 } } },
            tools: s.tools.map((t) => ({ type: "function", ...t })),
          },
        });
        this.ready();
      },
      (e) => this.onEvent(e),
    );
  }

  audio(b64: string) {
    this.send({ type: "input_audio_buffer.append", audio: b64 });
  }

  text(t: string) {
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: t }] } });
    this.send({ type: "response.create" });
  }

  toolResults(results: { id: string; name: string; output: unknown }[]) {
    for (const r of results) this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: r.id, output: JSON.stringify(r.output) } });
    this.outstanding -= results.length;
    this.maybeContinue();
  }

  private maybeContinue() {
    if (this.needResponse && !this.responding && this.outstanding <= 0) {
      this.needResponse = false;
      this.send({ type: "response.create" });
    }
  }

  private onEvent(e: Record<string, any>) {
    const h = this.h;
    switch (e.type) {
      case "input_audio_buffer.speech_started":
        h.userSpeaking();
        break;
      case "input_audio_buffer.speech_stopped":
        h.userStopped();
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (e.transcript) h.userText(e.transcript, `u-${e.item_id}`);
        break;
      case "response.created":
        this.responding = true;
        h.replying();
        break;
      case "response.output_audio.delta":
      case "response.audio.delta":
        h.audio(e.delta);
        break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        const key = `a-${e.response_id ?? e.item_id}`;
        this.texts[key] = (this.texts[key] ?? "") + e.delta;
        h.agentText(this.texts[key], key);
        break;
      }
      case "response.function_call_arguments.done": {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(e.arguments || "{}");
        } catch {
          /* leave empty */
        }
        this.needResponse = true;
        this.outstanding++;
        h.toolCalls([{ id: e.call_id, name: e.name, args }]);
        break;
      }
      case "response.done":
        this.responding = false;
        if (this.needResponse) this.maybeContinue();
        else h.turnDone();
        break;
      case "error":
        h.error(e.error?.message ?? JSON.stringify(e).slice(0, 200));
        break;
    }
  }
  private texts: Record<string, string> = {};
}

/** Gemini Live (BidiGenerateContent), with an ephemeral token from our backend. */
export class GeminiTransport extends WsTransport {
  private turn = 0;
  private said = "";
  private heard = "";
  private userKey: string | null = null;
  private inReply = false;

  open(s: Session, h: Handlers) {
    this.h = h;
    const generationConfig: Record<string, unknown> = {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: s.voice } } },
    };
    if (s.thinking) generationConfig.thinkingConfig = { thinkingLevel: s.thinking };
    return this.connect(
      "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained" +
        `?access_token=${encodeURIComponent(s.token)}`,
      undefined,
      () =>
        this.send({
          setup: {
            model: `models/${s.model}`,
            generationConfig,
            systemInstruction: { parts: [{ text: s.instructions }] },
            // Gemini rejects an object schema with no properties; leave those out.
            tools: [{ functionDeclarations: s.tools.map((t) => (Object.keys(t.parameters.properties).length ? t : { name: t.name, description: t.description })) }],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
          },
        }),
      (m) => this.onMessage(m),
    );
  }

  audio(b64: string) {
    this.send({ realtimeInput: { audio: { data: b64, mimeType: "audio/pcm;rate=24000" } } });
  }

  text(t: string) {
    this.send({ clientContent: { turns: [{ role: "user", parts: [{ text: t }] }], turnComplete: true } });
  }

  toolResults(results: { id: string; name: string; output: unknown }[]) {
    this.send({
      toolResponse: {
        functionResponses: results.map((r) => ({
          id: r.id,
          name: r.name,
          response: r.output && typeof r.output === "object" && !Array.isArray(r.output) ? r.output : { result: r.output },
        })),
      },
    });
  }

  private startReply() {
    if (this.inReply) return;
    this.inReply = true;
    this.userKey = null;
    this.h.replying();
  }

  private onMessage(m: Record<string, any>) {
    const h = this.h;
    if (m.setupComplete) return this.ready();
    if (m.toolCall) {
      this.startReply();
      h.toolCalls((m.toolCall.functionCalls ?? []).map((c: any) => ({ id: c.id, name: c.name, args: c.args ?? {} })));
    }
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) {
      if (!this.userKey) {
        this.userKey = `u-${Date.now()}`;
        this.heard = "";
        h.userSpeaking();
      }
      this.heard += sc.inputTranscription.text;
      h.userText(this.heard.trim(), this.userKey);
    }
    if (sc.interrupted) h.userSpeaking();
    for (const p of sc.modelTurn?.parts ?? []) {
      if (p.inlineData?.data) {
        this.startReply();
        h.audio(p.inlineData.data);
      }
    }
    if (sc.outputTranscription?.text) {
      this.startReply();
      this.said += sc.outputTranscription.text;
      h.agentText(this.said.trim(), `g-${this.turn}`);
    }
    if (sc.turnComplete) {
      this.inReply = false;
      if (this.said) {
        this.turn++;
        this.said = "";
      }
      h.turnDone();
    }
  }
}
