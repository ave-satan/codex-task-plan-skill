// Existing lifecycle assertions inspect state via the public read tool, not mutation replies.
export async function callWithSnapshot(client, request) {
  const result = await client.callTool(request);
  if (!result.isError && ['update_task_plan_step', 'revise_task_plan', 'cancel_task_plan'].includes(request.name)) {
    const read = await client.callTool({ name: 'get_task_plan', arguments: { plan_id: request.arguments.plan_id } });
    if (read.isError) throw new Error(JSON.stringify(read));
    return { ...result, structuredContent: { ...result.structuredContent, plan: read.structuredContent.plan } };
  }
  return result;
}
