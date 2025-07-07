from flask import Flask, render_template, request, redirect, url_for, jsonify, send_from_directory
import sqlite3
import os
import json
from datetime import datetime

app = Flask(__name__)
DATABASE = os.path.join(os.path.dirname(__file__), 'survey.db')
UPLOAD_FOLDER = os.path.join(os.path.dirname(__file__), 'uploads')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER

# Database initialization
def init_db():
    conn = sqlite3.connect(DATABASE)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS surveys (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    title TEXT NOT NULL
                )''')
    c.execute('''CREATE TABLE IF NOT EXISTS questions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    survey_id INTEGER,
                    text TEXT NOT NULL,
                    qtype TEXT NOT NULL,
                    config TEXT,
                    FOREIGN KEY(survey_id) REFERENCES surveys(id)
                )''')
    c.execute('''CREATE TABLE IF NOT EXISTS responses (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    survey_id INTEGER,
                    submitted_at TEXT,
                    FOREIGN KEY(survey_id) REFERENCES surveys(id)
                )''')
    c.execute('''CREATE TABLE IF NOT EXISTS answers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    response_id INTEGER,
                    question_id INTEGER,
                    text TEXT,
                    FOREIGN KEY(response_id) REFERENCES responses(id),
                    FOREIGN KEY(question_id) REFERENCES questions(id)
                )''')
    conn.commit()
    conn.close()

init_db()

@app.route('/')
def index():
    conn = sqlite3.connect(DATABASE)
    c = conn.cursor()
    c.execute('SELECT id, title FROM surveys')
    surveys = c.fetchall()
    conn.close()
    return render_template('index.html', surveys=surveys)

@app.route('/create', methods=['GET', 'POST'])
def create():
    if request.method == 'POST':
        title = request.form.get('title')
        titles = request.form.getlist('q_text')
        types = request.form.getlist('q_type')
        configs = request.form.getlist('q_config')
        conn = sqlite3.connect(DATABASE)
        c = conn.cursor()
        c.execute('INSERT INTO surveys (title) VALUES (?)', (title,))
        survey_id = c.lastrowid
        for text, qtype, cfg in zip(titles, types, configs):
            if text.strip():
                c.execute('INSERT INTO questions (survey_id, text, qtype, config) VALUES (?, ?, ?, ?)',
                          (survey_id, text.strip(), qtype, cfg or None))
        conn.commit()
        conn.close()
        return redirect(url_for('survey', survey_id=survey_id))
    return render_template('create.html')

@app.route('/survey/<int:survey_id>', methods=['GET', 'POST'])
def survey(survey_id):
    conn = sqlite3.connect(DATABASE)
    c = conn.cursor()
    c.execute('SELECT title FROM surveys WHERE id=?', (survey_id,))
    survey = c.fetchone()
    c.execute('SELECT id, text, qtype, COALESCE(config, "") FROM questions WHERE survey_id=?', (survey_id,))
    rows = c.fetchall()
    questions = []
    for row in rows:
        qid, text, qtype, cfg = row
        try:
            config = json.loads(cfg) if cfg else {}
        except json.JSONDecodeError:
            config = {}
        questions.append({'id': qid, 'text': text, 'type': qtype, 'config': config})
    if request.method == 'POST':
        c.execute('INSERT INTO responses (survey_id, submitted_at) VALUES (?, ?)',
                  (survey_id, datetime.utcnow().isoformat()))
        response_id = c.lastrowid
        for q in questions:
            qid = q['id']
            if q['type'] == 'file':
                f = request.files.get(str(qid))
                if f and f.filename:
                    fname = f"{response_id}_{qid}_{f.filename}"
                    path = os.path.join(app.config['UPLOAD_FOLDER'], fname)
                    f.save(path)
                    value = fname
                else:
                    value = ''
            elif q['type'] == 'choice_multi':
                value = ','.join(request.form.getlist(str(qid)))
            else:
                value = request.form.get(str(qid))
            c.execute('INSERT INTO answers (response_id, question_id, text) VALUES (?, ?, ?)',
                      (response_id, qid, value))
        conn.commit()
        conn.close()
        return redirect(url_for('thanks', survey_id=survey_id))
    conn.close()
    return render_template('survey.html', survey=survey, questions=questions)

@app.route('/thanks/<int:survey_id>')
def thanks(survey_id):
    return render_template('thanks.html', survey_id=survey_id)

@app.route('/results/<int:survey_id>')
def results(survey_id):
    conn = sqlite3.connect(DATABASE)
    c = conn.cursor()
    c.execute('SELECT title FROM surveys WHERE id=?', (survey_id,))
    survey = c.fetchone()
    c.execute('SELECT id, text, qtype FROM questions WHERE survey_id=?', (survey_id,))
    questions = c.fetchall()
    result_data = []
    for qid, text, qtype in questions:
        if qtype in ('choice_single', 'choice_multi', 'scale', 'pairwise'):
            c.execute('SELECT text, COUNT(*) FROM answers WHERE question_id=? GROUP BY text', (qid,))
            counts = c.fetchall()
            result_data.append({'question': text, 'counts': counts})
        else:
            c.execute('SELECT text FROM answers WHERE question_id=?', (qid,))
            texts = [row[0] for row in c.fetchall()]
            result_data.append({'question': text, 'texts': texts})
    conn.close()
    return render_template('results.html', survey=survey, results=result_data)

@app.route('/export/<int:survey_id>')
def export(survey_id):
    conn = sqlite3.connect(DATABASE)
    c = conn.cursor()
    c.execute('SELECT id, text, qtype FROM questions WHERE survey_id=?', (survey_id,))
    questions = c.fetchall()
    export_data = []
    for qid, text, qtype in questions:
        c.execute('SELECT text FROM answers WHERE question_id=?', (qid,))
        answers = [row[0] for row in c.fetchall()]
        export_data.append({'question': text, 'type': qtype, 'answers': answers})
    conn.close()
    return jsonify(export_data)

@app.route('/uploads/<path:filename>')
def uploaded_file(filename):
    return send_from_directory(app.config['UPLOAD_FOLDER'], filename)

if __name__ == '__main__':
    app.run(debug=True)
