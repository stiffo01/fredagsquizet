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

export const featureTestQuiz = {
  id: 'feature-test', title: 'Feature test quiz',
  questions: [
    { question: 'Picture preview: which shape is purple?', answers: ['Circle', 'Triangle', 'Square', 'Star'], correctIndex: 3, timeLimit: 20 },
    { type: 'true-false', question: 'This round demonstrates true or false questions.', answers: ['True', 'False'], correctIndex: 0, timeLimit: 15 },
    { type: 'type-answer', question: 'Type the word Fredagsquizet to try a typed answer.', acceptedAnswers: ['Fredagsquizet'], timeLimit: 30 },
    { type: 'map-pin', question: 'Place your pin on Stockholm, Sweden.', target: { lat: 59.3293, lng: 18.0686 }, maxDistanceKm: 2000, timeLimit: 60 },
    { type: 'poll', question: 'Which feature did you like most?', answers: ['Pictures', 'True or false', 'Typed answers', 'Emojis'], timeLimit: 20 },
  ],
};

export const normalizeAnswer = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
export const mediaPathPattern = /^\/media\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/;
export const pixelSpeeds = ['slow', 'normal', 'fast', 'very-fast'];
export const playerEmojis = ['😀', '😎', '🤓', '🥳', '🐸', '🦊', '🐼', '🐙', '🦄', '🐧', '🐢', '🦖', '🍕', '🚀', '⭐', '👾'];

export function validateQuiz(input, id = randomUUID()) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (!input || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120 || !Array.isArray(input.questions) || !input.questions.length || input.questions.length > 50) fail('A quiz needs a title and 1–50 questions.');
  if (input.creator != null && (typeof input.creator !== 'string' || input.creator.length > 80)) fail('Creator names must be at most 80 characters.');
  if (input.coverImage && (typeof input.coverImage !== 'string' || !mediaPathPattern.test(input.coverImage))) fail('Use an uploaded quiz cover image.');
  if (input.coverImageAlt != null && (typeof input.coverImageAlt !== 'string' || input.coverImageAlt.length > 200)) fail('Cover image descriptions must be at most 200 characters.');
  const questions = input.questions.map(q => {
    const type = q?.type ?? 'quiz';
    if (!q || !['quiz', 'true-false', 'type-answer', 'pixel-reveal', 'poll', 'map-pin', 'picture-choice'].includes(type)) fail('Choose a supported question type.');
    if (typeof q.question !== 'string' || !q.question.trim() || q.question.length > 500 || !Number.isFinite(q.timeLimit ?? 20) || (q.timeLimit ?? 20) < 1 || (q.timeLimit ?? 20) > 120) fail('Questions need a heading and a 1–120 second time limit.');
    if (q.image && (typeof q.image !== 'string' || !mediaPathPattern.test(q.image))) fail('Use an uploaded question image.');
    if (q.imageAlt != null && (typeof q.imageAlt !== 'string' || q.imageAlt.length > 200)) fail('Image descriptions must be at most 200 characters.');
    if (q.revealImage && (typeof q.revealImage !== 'string' || !mediaPathPattern.test(q.revealImage))) fail('Use an uploaded answer reveal image.');
    if (q.revealImageAlt != null && (typeof q.revealImageAlt !== 'string' || q.revealImageAlt.length > 200)) fail('Answer reveal image descriptions must be at most 200 characters.');
    if (q.revealImageTitle != null && (typeof q.revealImageTitle !== 'string' || q.revealImageTitle.length > 200)) fail('Answer reveal picture titles must be at most 200 characters.');
    const result = { type, question: q.question.trim(), timeLimit: q.timeLimit ?? 20, image: q.image || '', imageAlt: q.imageAlt || '', revealImage: q.revealImage || '', revealImageAlt: q.revealImageAlt || '', revealImageTitle: q.revealImageTitle?.trim() || '', showRevealImage: q.showRevealImage === true };
    if (type === 'map-pin') {
      if (!validLocation(q.target)) fail('Choose a target location on the map.');
      if (!Number.isFinite(q.maxDistanceKm) || q.maxDistanceKm < 1 || q.maxDistanceKm > 20000) fail('Choose a zero-point distance between 1 and 20,000 km.');
      result.target = { lat: q.target.lat, lng: q.target.lng };
      result.maxDistanceKm = q.maxDistanceKm;
      result.zoomNearTarget = q.zoomNearTarget === true;
    } else if (type === 'type-answer' || type === 'pixel-reveal') {
      if (type === 'pixel-reveal' && !q.image) fail('Pixelated picture questions need an uploaded picture.');
      if (type === 'pixel-reveal' && (!Number.isInteger(q.pixelRevealAt ?? 2) || (q.pixelRevealAt ?? 2) < 0 || (q.pixelRevealAt ?? 2) > 120)) fail('Show the original picture 0–120 seconds before time runs out.');
      if (type === 'pixel-reveal' && !pixelSpeeds.includes(q.pixelSpeed ?? 'normal')) fail('Choose a supported pixel effect speed.');
      if (!Array.isArray(q.acceptedAnswers) || !q.acceptedAnswers.length || q.acceptedAnswers.length > 10 || q.acceptedAnswers.some(a => typeof a !== 'string' || !a.trim() || a.length > 200)) fail('Typed questions need 1–10 accepted answers, up to 200 characters each.');
      result.acceptedAnswers = [...new Set(q.acceptedAnswers.map(a => a.trim()))];
      if (type === 'pixel-reveal') { result.pixelRevealAt = q.pixelRevealAt ?? 2; result.pixelSpeed = q.pixelSpeed ?? 'normal'; }
    } else if (type === 'picture-choice') {
      if (!Array.isArray(q.answerImages) || q.answerImages.length !== 2 || q.answerImages.some(image => typeof image !== 'string' || !mediaPathPattern.test(image))) fail('Picture choice questions need two uploaded pictures.');
      const captions = Array.isArray(q.answers) ? q.answers : [];
      if (captions.length > 2 || captions.some(a => typeof a !== 'string' || a.length > 200)) fail('Picture captions must be at most 200 characters.');
      if (q.correctIndex !== 0 && q.correctIndex !== 1) fail('Select the correct picture.');
      result.answerImages = [...q.answerImages];
      result.answers = [0, 1].map(j => captions[j]?.trim() || '');
      result.correctIndex = q.correctIndex;
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
  return { id, title: input.title.trim(), creator: input.creator?.trim() || '', coverImage: input.coverImage || '', coverImageAlt: input.coverImageAlt || '', questions };
}

export const validLocation = point => !!point && Number.isFinite(point.lat) && Number.isFinite(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180;

export function distanceKm(a, b) {
  const rad = degrees => degrees * Math.PI / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 6371.0088 * 2 * Math.asin(Math.sqrt(Math.max(0, Math.min(1, h))));
}

export const mapPoints = (distance, maxDistanceKm) => Math.max(0, Math.round(1000 * (1 - distance / maxDistanceKm)));
