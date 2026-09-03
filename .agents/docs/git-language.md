# Git Language

Commits and pull requests settle which language a sentence is written in. Word
choice reaches further than that, into code comments, test names, and issue
bodies as well.

## Commits

- Write commit titles and bodies in Korean.
- Keep the Conventional Commit type and optional scope in English.
- Keep code identifiers, file paths, commands, log output, error strings, API names, and technical terms in their canonical English form.

## Pull Requests

- Write pull request titles and bodies in Korean.
- Keep the Conventional Commit type and optional scope in English.
- Keep code identifiers, file paths, commands, log output, error strings, API names, technical terms, and template section headings in their canonical English form.

## Titles

A title is a label for the thing that changed, not a claim about it. This
covers commit subjects, pull request titles, and Jira 에픽 · 스토리 · 작업
summaries.

**Name the changed thing and say what happened to it.** The subject is
something a reader can grep for — a file, a module, a table, an endpoint, a
tool, a field. The verb is an edit: 추가한다, 옮긴다, 지운다, 고친다, 나눈다.
Give the number when there is one: `재시도 3회로 제한한다` beats
`재시도를 줄인다`.

**A title that states an insight is not a title.** `런은 agent 가 물어봐서
나아간다` reads well and cannot be checked — a reviewer holding the diff has no
way to say whether it is true, because it describes a design idea rather than
an edit. The same sentence as a label is
`QA 런에 tool 호출 상한과 벽시계 마감을 둔다`. Aphorisms, figures of speech, and
rhetorical questions all fail the same way. If it reads like a slide headline,
rewrite it.

| 나쁨 | 좋음 |
| --- | --- |
| `fix(qa): 런은 agent 가 물어봐서 나아간다` | `fix(qa): QA 런에 tool 호출 상한과 벽시계 마감을 둔다` |
| `refactor: 구조를 데이터로` | `refactor(qa): loop 상한과 vision 여부를 QaArchSpec 필드로 옮긴다` |
| `feat: 지식은 두 번 모델을 거친다` | `feat(knowledge): knowledge 항목마다 검색용 질문을 생성해 색인한다` |
| `docs: 이 발표의 문장은 코드 옆에 있다` | `docs: agent 파이프라인 문서에 원문 파일 경로 표를 넣는다` |

Jira levels differ only in what they name. An 에픽 names the outcome, a 스토리
names the behavior that changes, and a 작업 names what that one repository does
about it. None of the three is a place for a thesis.

This rule reaches the headings inside a document or a deck as well. A section
heading tells the reader what is in that section; it is not the place to make
the section's point.

## Word Choice

This section is about the words you pick when you write about this code: the
verbs, and the nouns for things the code never named. A thing the code does
name keeps the name the code gave it — `pulse`, `screen`, `capability`,
`anchor` — in backticks, even inside a Korean sentence.

It applies wherever that writing lands: line and block comments, KDoc and
docstrings, SQL comments, test names, commit messages, and issue and pull
request bodies.

**Never invent a Korean word to carry a technical meaning.** Verbs count as
much as nouns. The test is not whether a Korean rendering is possible. It is
whether a Korean speaker who has not read the code would use that word for
this. `발화하다` for `fire` fails it: nobody who has not read the file knows
what it means.

Where the ordinary Korean word is exact, use it. Merging two duplicate `screen`
rows really is `합친다` — `접는다` was reached for because it sounded closer to
the code, and it left the sentence harder to read and no more precise. Where
reaching for a Korean word produces something you had to make up, write the
English word instead. English is a safe answer. A made-up word never is.

**Pick the word that is correct, not the word that sounds considered.** Test a
word by asking whether it actually means this, not whether it sounds right in
the sentence. `capture 를 청구한다` is wrong because `청구` is the word for
collecting money; asking the SDK to take a screen capture is `요청`. Commonness
only breaks a tie: when two words are both correct, take the one the reader
already knows — `만들어낸 말` over `조어`. Never take a vague common word over
an exact one. A sentence that reads smoothly and says nothing is the worse
failure of the two.

**Prefer the precise term over the short ambiguous one**, especially where the
short one already means something else nearby. In prose write `screen capture`,
not `capture`: `content_map` also has a `capture` field whose values are
`editor`, `editor-play`, and `player`, and a reader cannot tell which one a
bare `capture` meant. Identifiers keep the names they have; this is about the
prose around them.

**Write concretely.** Name the thing, say what happens, give the number.
`재시도는 3회까지` beats `적절히 재시도한다`. Figurative or grand phrasing hides
whether the sentence is even true, and a reviewer cannot check a metaphor. A
short plain sentence with a number in it beats a well-turned one.

None of this asks for more Korean. It asks you to stop making words up. Leave
English where English reads naturally.

Existing text is not a defect to sweep. Words like these are already spread
through comments, documents, and branch names here; that is history, not a
standard. Fix the wording in text you are already writing, and leave the file
around it alone.
