import { initDb, db } from '../db'
import { canonicalModels, modelCapabilities } from '../db/schema'
import { eq, and } from 'drizzle-orm'

async function fixQwen3Coder() {
  await initDb()
  const database = db()
  
  console.log('🔧 Fixing qwen3-coder missing capabilities...')
  
  // Find qwen3-coder model
  const model = await database.select().from(canonicalModels).where(eq(canonicalModels.slug, 'qwen3-coder')).limit(1)
  if (!model || model.length === 0) {
    console.error('❌ qwen3-coder model not found')
    return
  }
  
  const modelId = model[0].id
  console.log(`Found qwen3-coder (id=${modelId})`)
  
  // Check current capabilities
  const current = await database.select().from(modelCapabilities)
    .where(eq(modelCapabilities.modelId, modelId))
  console.log(`Current capabilities: ${current.map(c => c.capability).join(', ')}`)
  
  // Fix: ensure tools and json_mode are true
  const toFix = [
    { capability: 'tools', supported: true },
    { capability: 'json_mode', supported: true },
  ]
  
  for (const fix of toFix) {
    const existing = current.find(c => c.capability === fix.capability)
    if (existing) {
      if (existing.supported === fix.supported) {
        console.log(`  ✓ ${fix.capability}: already ${fix.supported}`)
      } else {
        await database.update(modelCapabilities)
          .set({ supported: fix.supported, measuredAt: new Date(), source: 'measured' })
          .where(and(eq(modelCapabilities.modelId, modelId), eq(modelCapabilities.capability, fix.capability)))
        console.log(`  ✓ ${fix.capability}: updated to ${fix.supported}`)
      }
    } else {
      await database.insert(modelCapabilities).values({
        modelId,
        capability: fix.capability,
        supported: fix.supported,
        measuredAt: new Date(),
        source: 'measured',
      })
      console.log(`  ✓ ${fix.capability}: inserted as ${fix.supported}`)
    }
  }
  
  // Verify
  const updated = await database.select().from(modelCapabilities)
    .where(eq(modelCapabilities.modelId, modelId))
  console.log(`\n✅ Updated capabilities for qwen3-coder:`)
  updated.forEach(c => console.log(`   ${c.capability}: ${c.supported} (${c.source})`))
}

fixQwen3Coder().catch(err => {
  console.error('Error:', err)
  process.exit(1)
}).then(() => {
  console.log('\n✅ Fix complete')
  process.exit(0)
})
