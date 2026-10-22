// Демо-викторина. Её может запустить любой ведущий, в том числе без оплаты, но изменить нельзя:
// сервер запускает её сам по { demo: true }, а не по данным клиента.
export const DEMO_QUIZ = Object.freeze({
  title: 'Разминка: обо всём понемногу',
  questions: [
    { type: 'choice', text: 'Какая планета — самая большая в Солнечной системе?', answers: ['Марс', 'Юпитер', 'Сатурн', 'Нептун'], correct: 1, timeLimit: 20, readTime: 5 },
    { type: 'text', text: 'Столица Франции?', accepted: ['Париж', 'Paris'], timeLimit: 20, readTime: 3 },
    { type: 'choice', text: 'Сколько континентов на Земле?', answers: ['5', '6', '7', '8'], correct: 2, timeLimit: 15, readTime: 3 },
    { type: 'choice', text: 'Кто написал роман в стихах «Евгений Онегин»?', answers: ['Лермонтов', 'Пушкин', 'Толстой', 'Гоголь'], correct: 1, timeLimit: 20, readTime: 5 },
    { type: 'text', text: 'Сколько ног у паука?', accepted: ['8', 'восемь'], timeLimit: 15, readTime: 3 },
    { type: 'choice', text: 'Байкал — самое глубокое озеро в мире?', answers: ['Да', 'Нет'], correct: 0, timeLimit: 10, readTime: 0 },
    { type: 'choice', text: 'Какой химический элемент обозначается буквой O?', answers: ['Золото', 'Кислород', 'Осмий', 'Олово'], correct: 1, timeLimit: 20, readTime: 8 },
  ],
});
