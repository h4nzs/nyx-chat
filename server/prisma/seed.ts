import { PrismaClient } from '@prisma/client'
import * as argon2 from 'argon2'
import 'dotenv/config'

const prisma = new PrismaClient()

async function main() {
  try {
    const password = await argon2.hash('password123')

    const alice = await prisma.user.upsert({
      where: { email: 'alice@example.com' },
      update: {},
      create: {
        email: 'alice@example.com',
        username: 'alice',
        passwordHash: password,
        name: 'Alice'
      }
    })

    const bob = await prisma.user.upsert({
      where: { email: 'bob@example.com' },
      update: {},
      create: {
        email: 'bob@example.com',
        username: 'bob',
        passwordHash: password,
        name: 'Bob'
      }
    })

    // 1-1 conversation between Alice & Bob
    const conv = await prisma.conversation.create({
      data: {
        participants: {
          create: [{ userId: alice.id }, { userId: bob.id }]
        }
      }
    })

    await prisma.message.createMany({
      data: [
        { conversationId: conv.id, senderId: alice.id, content: 'Hi Bob!' },
        {
          conversationId: conv.id,
          senderId: bob.id,
          content: 'Hi Alice, welcome 👋'
        }
      ]
    })

    await prisma.conversation.update({
      where: { id: conv.id },
      data: { lastMessageAt: new Date() }
    })

    console.log('Seed completed:', { alice: alice.email, bob: bob.email })
  } catch (e) {
    console.error(e)
    process.exit(1)
  } finally {
    await prisma.$disconnect()
  }
}

main()
