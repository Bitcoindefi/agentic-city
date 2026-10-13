import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { enqueueTask, dequeue, peekNext, retryAll, failTask, getTask, resetTaskQueueForTests, listDeadLetterTasks } from "@/lib/agent-runtime/task-queue"
import { GET as getTaskRoute } from "@/app/api/tasks/[id]/route"
import { POST as createTaskRoute } from "@/app/api/tasks/route"

const jest = vi

describe("Task Queue", () => {
  beforeEach(() => {
    resetTaskQueueForTests()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("Tasks are dequeued in descending priority order (high priority before low)", () => {
    enqueueTask({ type: "low_task", priority: "low" })
    enqueueTask({ type: "critical_task", priority: "critical" })
    enqueueTask({ type: "normal_task", priority: "normal" })
    enqueueTask({ type: "high_task", priority: "high" })

    expect(dequeue()?.type).toBe("critical_task")
    expect(dequeue()?.type).toBe("high_task")
    expect(dequeue()?.type).toBe("normal_task")
    expect(dequeue()?.type).toBe("low_task")
  })

  it("enqueue() with equal priorities uses FIFO ordering", () => {
    enqueueTask({ type: "task1", priority: "normal" })
    jest.advanceTimersByTime(10)
    enqueueTask({ type: "task2", priority: "normal" })
    jest.advanceTimersByTime(10)
    enqueueTask({ type: "task3", priority: "normal" })

    expect(dequeue()?.type).toBe("task1")
    expect(dequeue()?.type).toBe("task2")
    expect(dequeue()?.type).toBe("task3")
  })

  it("A task that fails N times moves to the dead-letter queue", () => {
    const task = enqueueTask({ type: "fail_task", maxRetries: 2 })
    expect(task.status).toBe("pending")
    
    const leased1 = dequeue()!
    expect(leased1.id).toBe(task.id)

    failTask(leased1.id, "error 1")
    expect(getTask(task.id)?.status).toBe("pending")
    expect(getTask(task.id)?.retryCount).toBe(1)

    jest.advanceTimersByTime(5000)
    
    const leased2 = dequeue()!
    expect(leased2.id).toBe(task.id)

    failTask(leased2.id, "error 2")
    expect(getTask(task.id)?.status).toBe("pending")
    expect(getTask(task.id)?.retryCount).toBe(2)

    jest.advanceTimersByTime(15000)

    const leased3 = dequeue()!
    failTask(leased3.id, "error 3")
    
    const finalTask = getTask(task.id)
    expect(finalTask?.status).toBe("dead-letter")
    expect(finalTask?.error).toBe("error 3")
  })

  it("retryAll() moves dead-letter tasks back to the main queue", () => {
    const task1 = enqueueTask({ type: "t1", maxRetries: 0 })
    const task2 = enqueueTask({ type: "t2", maxRetries: 0 })

    dequeue() 
    failTask(task1.id, "fail t1") 
    dequeue() 
    failTask(task2.id, "fail t2") 

    expect(listDeadLetterTasks().length).toBe(2)
    
    const retriedCount = retryAll()
    expect(retriedCount).toBe(2)
    
    expect(listDeadLetterTasks().length).toBe(0)
    expect(getTask(task1.id)?.status).toBe("pending")
    expect(getTask(task2.id)?.status).toBe("pending")
    expect(getTask(task1.id)?.retryCount).toBe(0)
  })

  it("peekNext() returns the highest-priority item without dequeuing", () => {
    enqueueTask({ type: "low_task", priority: "low" })
    enqueueTask({ type: "high_task", priority: "high" })

    const peeked = peekNext()
    expect(peeked?.type).toBe("high_task")
    expect(peeked?.status).toBe("pending")
    
    const peekedAgain = peekNext()
    expect(peekedAgain?.type).toBe("high_task") 
  })

  it("Empty queue returns null from dequeue()", () => {
    expect(dequeue()).toBeNull()
  })

  it("POST /api/tasks returns 201 with the created task ID", async () => {
    const req = new Request("http://localhost:3000/api/tasks", {
      method: "POST",
      body: JSON.stringify({ type: "api_task", priority: "high" })
    })
    
    const res = await createTaskRoute(req)
    expect(res.status).toBe(201)
    
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.task.id).toBeDefined()
    expect(data.task.type).toBe("api_task")
    expect(data.task.priority).toBe("high")
    
    expect(getTask(data.task.id)).toBeDefined()
  })

  it("GET /api/tasks/[id] returns the task status correctly", async () => {
    const task = enqueueTask({ type: "status_task" })
    
    const req = new Request(`http://localhost:3000/api/tasks/${task.id}`)
    const res = await getTaskRoute(req, { params: Promise.resolve({ id: task.id }) })
    
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.task.id).toBe(task.id)
    expect(data.task.status).toBe("pending")
  })
})
