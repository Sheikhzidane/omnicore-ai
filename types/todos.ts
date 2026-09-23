// Legacy ops task types. The schema lives in types/database.ts; these aliases
// keep the existing `@/types/todos` imports across the /ops dashboard working.
import type { TodoRow } from './database'

export type { Database, TodoComment } from './database'

export type Todo         = TodoRow
export type TodoStatus   = TodoRow['status']
export type TodoPriority = TodoRow['priority']
export type TaskCategory = TodoRow['task_category']
