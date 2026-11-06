package com.formconfirmed.example;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.formconfirmed.example.Formconfirmed.Decision;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;

/** Unit test of the answer handling. Run: mvn test */
class FormconfirmedTest {

    @ParameterizedTest(name = "{0}")
    @CsvSource(delimiter = '|', textBlock = """
            allow                     | 200 | {"success":true,"score":0.9,"action":"allow","reasons":[],"error-codes":[]} | false | DELIVER
            flag                      | 200 | {"success":true,"score":0.5,"action":"flag","reasons":["too_fast"]}         | false | HOLD
            flag + own check          | 200 | {"success":true,"score":0.5,"action":"flag","reasons":["too_fast"]}         | true  | HOLD
            block                     | 200 | {"success":false,"action":"block","error-codes":["invalid-input-response"]} | false | REJECT
            browser outage claim      | 200 | {"success":false,"score":0.35,"action":"flag","reasons":["service_unavailable"],"error-codes":["service-unavailable"]} | false | HOLD
            outage claim + own check  | 200 | {"success":false,"action":"flag","reasons":["service_unavailable"]}         | true  | DELIVER
            outage claim with success | 200 | {"success":true,"action":"allow","reasons":["service_unavailable"]}         | false | HOLD
            wrong secret              | 200 | {"success":false,"action":"block","error-codes":["invalid-input-secret"]}   | false | HOLD
            site paused               | 200 | {"success":false,"action":"block","error-codes":["site-paused"]}            | false | HOLD
            no answer                 | 0   | ''                                                                          | false | HOLD
            HTTP 500                  | 500 | {"success":false}                                                           | false | HOLD
            not JSON                  | 200 | <html>maintenance</html>                                                    | false | HOLD
            unknown action            | 200 | {"success":true,"action":"maybe"}                                           | false | HOLD
            allow without success     | 200 | {"success":false,"action":"allow"}                                          | false | HOLD
            allow with string success | 200 | {"success":"true","action":"allow"}                                         | false | HOLD
            """)
    void decides(String name, int status, String body, boolean ownCheck, Decision want) {
        assertEquals(want, Formconfirmed.decide(Formconfirmed.readAnswer(status, body), () -> ownCheck));
    }
}
