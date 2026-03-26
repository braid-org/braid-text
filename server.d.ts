import { IncomingMessage, ServerResponse } from 'http'

interface PutCallbackParams {
  old_val: string
  patches: Array<{ unit: string; range: string; content: string }> | null
  version: string[]
  parents: string[]
}

interface ServeOptions {
  key?: string
  put_cb?: (key: string, val: string, params: PutCallbackParams) => void
}

interface GetResult {
  version: string[]
  body: string | Uint8Array
}

interface Resource {
  key: string
  val: string
  version: string[]
}

interface BraidText {
  verbose: boolean
  db_folder: string | null
  cors: boolean
  cache: Record<string, Promise<Resource>>

  serve(req: IncomingMessage, res: ServerResponse, options?: ServeOptions): Promise<void>
  get(key: string): Promise<string | null>
  get(key: string, options: Record<string, any>): Promise<GetResult>
  put(key: string, options: Record<string, any>): Promise<{ change_count: number }>
  delete(key: string): Promise<void>
  list(): Promise<string[]>
  sync(a: string, b: string | URL, options?: Record<string, any>): Promise<void>
  free_cors(res: ServerResponse): void
  create_braid_text(): BraidText
}

declare const braidText: BraidText
export = braidText
