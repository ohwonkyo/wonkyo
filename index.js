const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// simple middleware to parse URL encoded bodies
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.send('<h1>Welcome to Wonkyo Survey App</h1>');
});

app.get('/dashboard', (req, res) => {
  res.send('Dashboard - 설문 수, 응답 수 등 요약 페이지');
});

app.get('/survey/new', (req, res) => {
  res.send('설문 생성 페이지');
});

app.get('/survey/:id/edit', (req, res) => {
  res.send('설문 편집 페이지: ' + req.params.id);
});

app.get('/survey/:id', (req, res) => {
  res.send('설문 응답 페이지: ' + req.params.id);
});

app.get('/survey/:id/results', (req, res) => {
  res.send('설문 결과 페이지: ' + req.params.id);
});

app.get('/login', (req, res) => {
  res.send('로그인 페이지');
});

app.get('/register', (req, res) => {
  res.send('회원가입 페이지');
});

app.get('/admin', (req, res) => {
  res.send('관리자 페이지');
});

app.get('/data-export', (req, res) => {
  res.send('데이터 내보내기 페이지');
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
