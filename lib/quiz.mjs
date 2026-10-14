import { randomUUID } from 'node:crypto';

export const sampleQuiz = {
  id: 'sample', title: 'The curiosity quiz',
  questions: [
    { question: 'Which planet has the most prominent rings?', answers: ['Mars', 'Saturn', 'Venus', 'Mercury'], correctIndex: 1, timeLimit: 20 },
    { question: 'What does a caterpillar become?', answers: ['A beetle', 'A dragonfly', 'A butterfly or moth', 'A spider'], correctIndex: 2, timeLimit: 20 },
    { question: 'How many sides does a hexagon have?', answers: ['Five', 'Six', 'Seven', 'Eight'], correctIndex: 1, timeLimit: 20 },
    { question: 'Which of these is a programming language?', answers: ['Python', 'Iguana', 'Gecko', 'Cobra lily'], correctIndex: 0, timeLimit: 20 },
    { question: 'What is the largest ocean on Earth?', answers: ['Atlantic', 'Indian', 'Arctic', 'Pacific'], correctIndex: 3, timeLimit: 20 },
  ],
};

export function validateQuiz(input, id = randomUUID()) {
  const fail = () => { throw Object.assign(new Error('A quiz needs a title and 1–50 questions. Each question needs 2–4 answers, a correct answer, and a 1–120 second time limit.'), { status: 400 }); };
  if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120 || !Array.isArray(input.questions) || !input.questions.length || input.questions.length > 50) fail();
  const questions = input.questions.map(q => {
    if (!q || typeof q.question !== 'string' || !q.question.trim() || q.question.length > 500 || !Array.isArray(q.answers) || q.answers.length < 2 || q.answers.length > 4 || q.answers.some(a => typeof a !== 'string' || !a.trim() || a.length > 200) || !Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= q.answers.length || !Number.isFinite(q.timeLimit ?? 20) || (q.timeLimit ?? 20) < 1 || (q.timeLimit ?? 20) > 120) fail();
    return { question: q.question.trim(), answers: q.answers.map(a => a.trim()), correctIndex: q.correctIndex, timeLimit: q.timeLimit ?? 20 };
  });
  return { id, title: input.title.trim(), questions };
}
