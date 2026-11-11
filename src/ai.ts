/** The optional host AI service contract used by subtitle summaries. */
export interface AiModelSelection {
  ai: string
  model: string
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AiService {
  get(name?: string): { name: string } | undefined
  chat(messages: AiMessage[], options: AiModelSelection & { signal?: AbortSignal }): Promise<{ text: string }>
}
