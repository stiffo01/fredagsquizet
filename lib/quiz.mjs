import { randomUUID } from 'node:crypto';

export const sampleQuiz = {
  id: 'sample', title: 'The curiosity quiz',
  questions: [
    { question: 'Which planet has the most prominent rings?', answers: ['Mars', 'Saturn', 'Venus', 'Mercury'], correctIndex: 1, timeLimit: 20 },
    { type: 'true-false', question: 'A caterpillar can become a butterfly.', answers: ['True', 'False'], correctIndex: 0, timeLimit: 20 },
    { question: 'How many sides does a hexagon have?', answers: ['Five', 'Six', 'Seven', 'Eight'], correctIndex: 1, timeLimit: 20 },
    { type: 'type-answer', question: 'What is the capital of Sweden?', acceptedAnswers: ['Stockholm'], timeLimit: 30 },
    { type: 'poll', question: 'Which topic would you like to play next?', answers: ['Nature', 'Science', 'Geography', 'Movies'], timeLimit: 20 },
  ],
};

export const normalizeAnswer = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
export const mediaPathPattern = /^\/media\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/;
export const playerEmojis = ['😀', '😎', '🤓', '🥳', '🐸', '🦊', '🐼', '🐙', '🦄', '🐧', '🐢', '🦖', '🍕', '🚀', '⭐', '👾'];

export function validateQuiz(input, id = randomUUID()) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120 || !Array.isArray(input.questions) || !input.questions.length || input.questions.length > 50) fail('A quiz needs a title and 1–50 questions.');
  if (input.coverImage && (typeof input.coverImage !== 'string' || !mediaPathPattern.test(input.coverImage))) fail('Use an uploaded quiz cover image.');
  if (input.coverImageAlt != null && (typeof input.coverImageAlt !== 'string' || input.coverImageAlt.length > 200)) fail('Cover image descriptions must be at most 200 characters.');
  const questions = input.questions.map(q => {
    const type = q?.type ?? 'quiz';
    if (!q || !['quiz', 'true-false', 'type-answer', 'poll'].includes(type)) fail('Choose a supported question type.');
    if (typeof q.question !== 'string' || !q.question.trim() || q.question.length > 500 || !Number.isFinite(q.timeLimit ?? 20) || (q.timeLimit ?? 20) < 1 || (q.timeLimit ?? 20) > 120) fail('Questions need a heading and a 1–120 second time limit.');
    if (q.image && (typeof q.image !== 'string' || !mediaPathPattern.test(q.image))) fail('Use an uploaded question image.');
    if (q.imageAlt != null && (typeof q.imageAlt !== 'string' || q.imageAlt.length > 200)) fail('Image descriptions must be at most 200 characters.');
    const result = { type, question: q.question.trim(), timeLimit: q.timeLimit ?? 20, image: q.image || '', imageAlt: q.imageAlt || '' };
    if (type === 'type-answer') {
      if (!Array.isArray(q.acceptedAnswers) || !q.acceptedAnswers.length || q.acceptedAnswers.length > 10 || q.acceptedAnswers.some(a => typeof a !== 'string' || !a.trim() || a.length > 200)) fail('Typed questions need 1–10 accepted answers, up to 200 characters each.');
      result.acceptedAnswers = [...new Set(q.acceptedAnswers.map(a => a.trim()))];
    } else {
      const answers = type === 'true-false' ? ['True', 'False'] : q.answers;
      if (!Array.isArray(answers) || answers.length < 2 || answers.length > 4 || answers.some(a => typeof a !== 'string' || !a.trim() || a.length > 200)) fail('Choose 2–4 non-empty answers, up to 200 characters each.');
      result.answers = answers.map(a => a.trim());
      if (type !== 'poll') {
        if (!Number.isInteger(q.correctIndex) || q.correctIndex < 0 || q.correctIndex >= answers.length) fail('Select a correct answer.');
        result.correctIndex = q.correctIndex;
      }
    }
    return result;
  });
  return { id, title: input.title.trim(), coverImage: input.coverImage || '', coverImageAlt: input.coverImageAlt || '', questions };
}
